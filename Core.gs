/** Core.gs - constants, date helpers, Db layer (memoized reads, cache, lock, audit) and Auth (token links + roles). */

// Every sheet the app owns, with its header. Missing sheets are created; missing columns are appended (never deleted).
var SHEETS = {
  Schedules:  ['Schedule', 'Day', 'Slot', 'Label', 'Start', 'End', 'Break'],
  Classes:    ['Class', 'Schedule'],
  Timetable:  ['Class', 'Day', 'Slot', 'Subject', 'Teachers'],            // legacy cell text, kept for migration/backup
  Lessons:    ['id', 'classId', 'day', 'period', 'subjectId', 'teacherIds', 'group', 'roomId', 'locked', 'sharedApprovedId'],
  Subjects:   ['Subject', 'Color', 'Icon'],   // Icon: an emoji or a small data:image (picked in Settings > Subjects)
  Teachers:   ['Teacher ID', 'Name', 'MaxDay', 'MaxWeek', 'Language'],
  Assignments:['Class', 'Subject', 'Teacher ID', 'Teacher', 'Primary', 'Active', 'Notes'],
  WeeklyReq:  ['Grade', 'Subject', 'Weekly'],
  Blocked:    ['Teacher ID', 'Day', 'Start', 'End', 'Note', 'Kind'],      // Kind: unavailable | locked
  Shared:     ['id', 'Teacher ID', 'Day', 'Start', 'Subject', 'Classes'], // approved shared lessons
  Rooms:      ['Room ID', 'Name'],
  Access:     ['Email'],                                                  // legacy: extra admins identified by Google e-mail
  Users:      ['Token', 'Name', 'Email', 'Role', 'Scope', 'Edit', 'Active', 'Register', 'Created'], // personal links: role + scope
  Ignored:    ['Key', 'Time', 'By'],
  Settings:   ['Key', 'Value'],
  Log:        ['Time', 'Class', 'Day', 'Slot', 'Old', 'New', 'User'],
  Notifications: ['id', 'Time', 'By', 'Kind', 'Classes', 'Teachers', 'Data', 'Pushed'], // one row per timetable change (Pushed: '' = waiting for web-push)
  Push:       ['Token', 'Endpoint', 'Sub', 'Lang', 'Created']                 // web-push subscriptions, one per installed device
};
// Legacy sheet names from the old app. SharedOK is migrated into Shared.
var LEGACY_SHARED = 'SharedOK';

var DEFAULTS = {
  days: [0, 1, 2, 3, 4],            // 0 = Sunday ... 6 = Saturday
  year: '2026-2027',
  maxDay: 8, maxWeek: 35,
  requireAssigned: true,
  school: 'Norwich International College',
  division: 'American Division'
};

/* ---------- date / time helpers ---------- */
function toMin_(t) {                // "08:55" | Date | 8.55 -> minutes since midnight
  if (t instanceof Date) return t.getHours() * 60 + t.getMinutes();
  var m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : 0;
}
function now_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function uid_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function key_(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/* ---------- Db layer ---------- */
/* Chunked CacheService helper: one value may be up to 100 KB, so long JSON is split (the part count is written last, in the same putAll). */
var Cc = {
  get: function (key) {
    var c = CacheService.getScriptCache(), n = +c.get(key + '#n');
    if (!n) return null;
    var keys = []; for (var i = 0; i < n; i++) keys.push(key + '#' + i);
    var m = c.getAll(keys), out = '';
    for (var j = 0; j < n; j++) { var v = m[keys[j]]; if (v == null) return null; out += v; }
    return out;
  },
  put: function (key, str, ttl) {
    try {
      var o = {}, n = 0, step = 30000;                      // 30000 chars <= 90 KB even with 3-byte letters
      for (var i = 0; i < str.length; i += step) o[key + '#' + (n++)] = str.substr(i, step);
      o[key + '#n'] = String(n);
      CacheService.getScriptCache().putAll(o, ttl);
    } catch (e) { /* too big or cache unavailable: just skip */ }
  },
  del: function (key) { try { CacheService.getScriptCache().remove(key + '#n'); } catch (e) { } },
  ver: function () {                                        // changes on every write to a data table: keys derived from it expire by themselves
    var c = CacheService.getScriptCache(), v = c.get('ver');
    if (!v) { v = String(Date.now()); c.put('ver', v, 21600); }
    return v;
  },
  bump: function () { try { CacheService.getScriptCache().put('ver', String(Date.now()) + Math.floor(Math.random() * 1000), 21600); } catch (e) { } }
};

var Db = (function () {
  var memo = {};                    // per-request memoization: a web-app call is one execution, so this is request-scoped
  var CACHED = { Schedules: 600, Classes: 600, Subjects: 600, Teachers: 600, Assignments: 600, WeeklyReq: 600, Blocked: 600, Shared: 600, Rooms: 600, Access: 600, Settings: 600, Lessons: 600, Ignored: 600, Notifications: 600, Users: 60 }; // seconds; every write drops its table. Users: short, so a disabled link stops working within a minute even if the sheet was edited by hand
  var NOBUMP = { Log: 1, Users: 1, Notifications: 1, Push: 1 };   // writes to these do not change the timetable data

  function sheet(name) {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), s = ss.getSheetByName(name), head = SHEETS[name];
    if (!s) {
      s = ss.insertSheet(name);
      s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      s.setFrozenRows(1);
      return s;
    }
    // migrate: append any header the older sheet does not have yet
    var have = s.getLastColumn() ? s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0] : [];
    if (have.length < head.length) {
      s.getRange(1, have.length + 1, 1, head.length - have.length).setValues([head.slice(have.length)]).setFontWeight('bold');
    }
    return s;
  }
  function raw(name) {              // all data rows as display strings, blank rows dropped
    var s = sheet(name), n = SHEETS[name].length, last = s.getLastRow();
    if (last < 2) return [];
    return s.getRange(2, 1, last - 1, n).getDisplayValues().filter(function (r) { return String(r[0]).trim(); });
  }
  function read(name) {
    if (memo[name]) return memo[name];
    var hit = CACHED[name] ? Cc.get('tbl:' + name) : null;
    if (hit) { try { return (memo[name] = JSON.parse(hit)); } catch (e) { /* fall through to the sheet */ } }
    var rows = raw(name);
    if (CACHED[name]) Cc.put('tbl:' + name, JSON.stringify(rows), CACHED[name]);
    return (memo[name] = rows);
  }
  function drop(name) {             // invalidate on EVERY write
    delete memo[name];
    if (CACHED[name]) Cc.del('tbl:' + name);
    if (!NOBUMP[name]) Cc.bump();
  }
  function replace(name, rows) {
    var s = sheet(name), n = SHEETS[name].length, last = s.getLastRow();
    if (last > 1) s.getRange(2, 1, last - 1, n).clearContent();
    if (rows.length) {
      var r = s.getRange(2, 1, rows.length, n);
      r.setNumberFormat('@');
      r.setValues(rows.map(function (x) { var y = x.slice(0, n).map(function (v) { return v == null ? '' : String(v); }); while (y.length < n) y.push(''); return y; }));
    }
    drop(name);
  }
  function append(name, rows) {
    if (!rows.length) return;
    var s = sheet(name), n = SHEETS[name].length, r = s.getRange(s.getLastRow() + 1, 1, rows.length, n);
    r.setNumberFormat('@');
    r.setValues(rows.map(function (x) { var y = x.map(String); while (y.length < n) y.push(''); return y; }));
    drop(name);
  }
  function lock(fn) {               // serialise every write
    var l = LockService.getScriptLock();
    l.waitLock(20000);
    try { return fn(); } finally { l.releaseLock(); }
  }
  function clearAll() { Object.keys(CACHED).forEach(function (n) { Cc.del('tbl:' + n); }); Cc.del('conf'); Cc.bump(); memo = {}; }
  return { sheet: sheet, read: read, replace: replace, append: append, lock: lock, drop: drop, clearAll: clearAll, raw: raw };
})();

/* ---------- settings (small key/value, JSON values) ---------- */
function getSettings_() {
  var o = {}, k;
  for (k in DEFAULTS) o[k] = DEFAULTS[k];
  Db.read('Settings').forEach(function (r) { try { o[r[0]] = JSON.parse(r[1]); } catch (e) { o[r[0]] = r[1]; } });
  return o;
}
function setSetting_(key, val) {
  var rows = Db.read('Settings').filter(function (r) { return r[0] !== key; });
  rows.push([key, JSON.stringify(val)]);
  Db.replace('Settings', rows);
}

/* ---------- audit ---------- */
function audit_(cls, day, slot, oldV, newV) {
  Db.append('Log', [[now_(), cls, day, slot, oldV, newV, Auth.who()]]);
}

/* ---------- Auth ----------
 * Who is calling is decided per request by Auth.init(token) (see api_call in Roles.gs):
 *  1. a personal link token found in the Users sheet (role admin | coordinator | teacher | viewer + scope), or
 *  2. a Google e-mail that is the sheet owner or listed in the legacy Access sheet -> admin.
 * Anything else is denied. There is no "open to everyone" mode any more. */
var Auth = {
  user: null, role: '', canEdit: false, pending: false, cls: null, tids: null,
  email: function () { try { return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; } },
  owner: function () { try { return SpreadsheetApp.getActiveSpreadsheet().getOwner().getEmail(); } catch (e) { return ''; } },
  init: function (tok) {
    this.user = null; this.role = ''; this.canEdit = false; this.pending = false; this.cls = null; this.tids = null;
    tok = String(tok || '').trim();
    var u = null;
    if (tok) Db.read('Users').forEach(function (r) { if (r[0] === tok && !/^n/i.test(r[6])) u = r; });
    if (u) {
      this.user = u;
      this.role = key_(u[3]);
      if (['admin', 'coordinator', 'teacher', 'viewer'].indexOf(this.role) < 0) this.role = 'viewer';
      this.canEdit = this.role === 'admin' || (this.role === 'coordinator' && /^y/i.test(u[5]));
      this.pending = /^y/i.test(u[7]) && this.role !== 'admin';
    } else {
      // identify by the REAL visitor only: email() falls back to the effective user (= the owner) when the visitor is anonymous,
      // which would make every anonymous visitor an admin when the app runs as "Execute as: Me".
      var me = ''; try { me = key_(Session.getActiveUser().getEmail()); } catch (e) { }
      var list = Db.read('Access').map(function (r) { return key_(r[0]); }).filter(Boolean);
      if (me && (me === key_(this.owner()) || list.indexOf(me) >= 0)) { this.role = 'admin'; this.canEdit = true; }
    }
    if (this.role && this.role !== 'admin') applyScope_(this);
    return this.role;
  },
  who: function () {
    if (this.user) return (this.user[1] || this.user[2] || 'link') + ' (' + this.role + ')';
    return this.email() || '';
  },
  require: function () { if (!this.role) throw new Error('Access denied. Open the app with your personal link.'); }
};
