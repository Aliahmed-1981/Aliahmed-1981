/** Notify.gs - change notifications: an in-app list (sheet "Notifications") + web-push to installed devices (sheet "Push").
 *
 * How it works
 *  1. api_call (Roles.gs) compares the Lessons table before and after every write. Each changed cell becomes one entry; one write = one Notifications row.
 *  2. api_notifs returns the rows the caller may see (same scope rules as the timetable itself: admin = all, others only their classes / teacher ids).
 *  3. The browser calls api_flushPush after a save (fire and forget, so saving stays fast). It sends every waiting row as a web-push to the devices
 *     whose owner may see the change, through the tiny Netlify function /.netlify/functions/push (Apps Script cannot sign web-push by itself).
 *  The person who made the change is not notified about it.
 */

var DAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var DAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
var KIND_BY_FN = { api_saveCell: 'edit', api_moveEntry: 'move', api_swap: 'swap', api_restoreCells: 'undo', api_import: 'import', api_splitMfl: 'edit', api_saveTable: 'edit' };

function cellKey_(r) { return r[1] + '|' + (+r[2]) + '|' + (+r[3]); }
function cellMap_(rows) { var m = {}; rows.forEach(function (r) { (m[cellKey_(r)] = m[cellKey_(r)] || []).push(r); }); return m; }
function lessonSig_(r) { return [r[4], r[5], r[6], r[7]].join('~'); }          // subject, teachers, group, room (id / lock flag do not count)

/** Compare the Lessons table before / after a write and store one notification row. */
function notifyChange_(fn, before, after) {
  if (before === after) return;
  var B = cellMap_(before), A = cellMap_(after), keys = {}, ch = [], classes = {}, tids = {}, more = 0;
  Object.keys(B).concat(Object.keys(A)).forEach(function (k) { keys[k] = 1; });
  var names = {}; Db.read('Teachers').forEach(function (r) { names[r[0]] = r[1]; });
  function desc(r) {
    var t = r[5] ? String(r[5]).split(',').filter(Boolean) : [];
    return r[4] + (r[6] ? ' [' + r[6] + ']' : '') + (t.length ? ' (' + t.map(function (x) { return names[x] || x; }).join('+') + ')' : '');
  }
  Object.keys(keys).sort().forEach(function (k) {
    var o = B[k] || [], n = A[k] || [];
    var so = o.map(lessonSig_).sort().join('|'), sn = n.map(lessonSig_).sort().join('|');
    if (so === sn) return;
    var p = k.split('|'), t = {};
    o.concat(n).forEach(function (r) { String(r[5] || '').split(',').filter(Boolean).forEach(function (x) { t[x] = 1; tids[x] = 1; }); });
    classes[p[0]] = 1;
    if (ch.length >= 40) { more++; return; }
    ch.push({ c: p[0], d: +p[1], p: +p[2], o: o.map(desc), n: n.map(desc), t: Object.keys(t) });
  });
  if (!ch.length && !more) return;
  Db.lock(function () {
    Db.append('Notifications', [[String(Date.now()), now_(), Auth.who(), KIND_BY_FN[fn] || 'edit', Object.keys(classes).join(','), Object.keys(tids).join(','), JSON.stringify({ ch: ch, more: more }), '']]);
  });
}

/** Can a person with scope A (see applyScope_) see this changed cell? Admins see everything; an excluded class is hidden even for its teachers. */
function seesChange_(A, role, c) {
  if (role === 'admin') return true;
  if (A.ex && A.ex[c.c]) return false;
  return !!((A.cls && A.cls[c.c]) || (A.tids && (c.t || []).some(function (t) { return A.tids[t]; })));
}
function parseNote_(r) { var d = {}; try { d = JSON.parse(r[6]); } catch (e) { } return { id: r[0], time: r[1], by: r[2], kind: r[3], ch: d.ch || [], more: d.more || 0 }; }

/** The caller's notifications, newest first (at most 40). */
function api_notifs() {
  var me = Auth.who(), out = [];
  var rows = Db.read('Notifications');
  for (var i = rows.length - 1; i >= 0 && out.length < 40; i--) {
    var n = parseNote_(rows[i]);
    n.ch = n.ch.filter(function (c) { return seesChange_(Auth, Auth.role, c); });
    if (!n.ch.length) continue;
    n.mine = n.by === me;
    out.push(n);
  }
  return { items: out, now: Date.now() };
}

/* ---------- web-push subscriptions ---------- */
function api_pushSub(sub, lang) {
  if (!Auth.user) throw new Error('Push needs a personal link.');
  if (!sub || !/^https:\/\//.test(String(sub.endpoint || '')) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Invalid subscription.');
  var tok = Auth.user[0], ep = String(sub.endpoint);
  Db.lock(function () {
    var rows = Db.read('Push').filter(function (r) { return r[1] !== ep; });
    rows.push([tok, ep, JSON.stringify({ endpoint: ep, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }), lang === 'ar' ? 'ar' : 'en', now_()]);
    var mine = rows.filter(function (r) { return r[0] === tok; });                 // at most 5 devices per person (oldest dropped)
    if (mine.length > 5) { var drop = {}; mine.slice(0, mine.length - 5).forEach(function (r) { drop[r[1]] = 1; }); rows = rows.filter(function (r) { return !drop[r[1]]; }); }
    Db.replace('Push', rows);
  });
  return true;
}
function api_pushUnsub(endpoint) {
  if (!Auth.user) return true;
  var tok = Auth.user[0];
  Db.lock(function () { Db.replace('Push', Db.read('Push').filter(function (r) { return !(r[0] === tok && r[1] === String(endpoint)); })); });
  return true;
}

/** Send every waiting notification as web-push. Safe to call often; does nothing when nothing is waiting. */
function api_flushPush() {
  var props = PropertiesService.getScriptProperties(), url = props.getProperty('PUSH_URL'), secret = props.getProperty('PUSH_SECRET');
  var pend = [], all;
  Db.lock(function () {
    all = Db.read('Notifications');
    pend = all.filter(function (r) { return r[7] === ''; });
    if (!pend.length) return;
    var mark = url && secret ? '1' : '-';                                          // not configured: just close them, never send old ones later
    var done = all.map(function (r) { if (r[7] !== '') return r; r = r.slice(); r[7] = mark; return r; });
    Db.replace('Notifications', done.slice(-500));
  });
  if (!pend.length || !url || !secret) return { sent: 0 };
  pend = pend.slice(-20).map(parseNote_);

  var users = {}; Db.read('Users').forEach(function (r) { if (!/^n/i.test(r[6]) && !(/^y/i.test(r[7]) && key_(r[3]) !== 'admin')) users[r[0]] = r; });
  var items = [], gone = {}, scopes = {};
  Db.read('Push').forEach(function (s) {
    var u = users[s[0]]; if (!u) { gone[s[1]] = 1; return; }
    var role = key_(u[3]); if (['admin', 'coordinator', 'teacher', 'viewer'].indexOf(role) < 0) role = 'viewer';
    var sc = scopes[s[0]];
    if (!sc) { sc = scopes[s[0]] = { user: u }; if (role !== 'admin') applyScope_(sc); }
    var who = (u[1] || u[2] || 'link') + ' (' + role + ')', ar = s[3] === 'ar', days = ar ? DAY_AR : DAY_EN, lines = [], count = 0, sub;
    try { sub = JSON.parse(s[2]); } catch (e) { gone[s[1]] = 1; return; }
    pend.forEach(function (n) {
      if (n.by === who) return;
      var vis = n.ch.filter(function (c) { return seesChange_(sc, role, c); });
      if (!vis.length) return;
      count++;
      vis.slice(0, 3).forEach(function (c) {
        if (lines.length < 3) lines.push(c.c + ' · ' + days[c.d] + ' ' + (ar ? 'ح' : 'P') + c.p + ': ' + (c.o.join(' / ') || '—') + ' → ' + (c.n.join(' / ') || '—'));
      });
    });
    if (!count) return;
    items.push({ sub: sub, payload: { title: ar ? 'تعديل في الجدول' : 'Timetable updated', body: lines.join('\n') + (count > 1 ? '\n+' + (count - 1) + (ar ? ' تعديلات أخرى' : ' more changes') : ''), tag: 'tt-' + pend[pend.length - 1].id, url: './', ts: Date.now(), n: count } });
  });
  var sent = 0;
  if (items.length) {
    try {
      var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ secret: secret, items: items }), muteHttpExceptions: true, followRedirects: true });
      var j = {}; try { j = JSON.parse(res.getContentText()); } catch (e) { }
      sent = j.sent || 0; (j.gone || []).forEach(function (ep) { gone[ep] = 1; });
    } catch (e) { Logger.log('push: ' + e); }
  }
  if (Object.keys(gone).length) Db.lock(function () { Db.replace('Push', Db.read('Push').filter(function (r) { return !gone[r[1]]; })); });
  return { sent: sent };
}

/* ---------- one-time setup (edit the three values, pick "setup" in the editor, press Run) ---------- */
function setup() {
  var FRONT_URL = 'https://YOUR-NAME.github.io';                            // where the app page lives (no slash at the end). Personal links are built from it
  var PUSH_SITE = 'https://YOUR-SITE.netlify.app';                          // the Netlify site that holds the push function (can be the same address as FRONT_URL)
  var PUSH_SECRET = 'PUT-A-LONG-RANDOM-TEXT-HERE';                          // the same text you put in Netlify as PUSH_SECRET
  if (/YOUR-NAME|YOUR-SITE|PUT-A-LONG/.test(FRONT_URL + PUSH_SITE + PUSH_SECRET)) throw new Error('Edit FRONT_URL, PUSH_SITE and PUSH_SECRET inside setup() first.');
  FRONT_URL = FRONT_URL.replace(/\/+$/, ''); PUSH_SITE = PUSH_SITE.replace(/\/+$/, '');
  PropertiesService.getScriptProperties().setProperties({ FRONT_URL: FRONT_URL, PUSH_URL: PUSH_SITE + '/.netlify/functions/push', PUSH_SECRET: PUSH_SECRET });
  Db.sheet('Notifications'); Db.sheet('Push');
  Logger.log('Saved. Now run adminLinkLog to see your admin link.');
}
/** Menu item: use it after editing the sheets by hand (the app caches reads for a few minutes). */
function refreshCache() { Db.clearAll(); try { SpreadsheetApp.getActiveSpreadsheet().toast('Cache cleared'); } catch (e) { } }

/** Run this from the editor when notifications do not arrive: it tells you which link in the chain is broken (see View > Logs). */
function diagPush() {
  var p = PropertiesService.getScriptProperties(), url = p.getProperty('PUSH_URL'), sec = p.getProperty('PUSH_SECRET');
  var subs = Db.read('Push'), notes = Db.read('Notifications');
  Logger.log('FRONT_URL = ' + p.getProperty('FRONT_URL'));
  Logger.log('PUSH_URL  = ' + url + '   | secret saved: ' + !!sec);
  Logger.log('devices subscribed: ' + subs.length);
  Logger.log('changes recorded: ' + notes.length + '   | waiting to be pushed: ' + notes.filter(function (r) { return r[7] === ''; }).length + '   | already handled: ' + notes.filter(function (r) { return r[7] !== ''; }).length);
  if (!url || !sec) { Logger.log('=> PUSH_URL / PUSH_SECRET are not saved. Run setup() again.'); return; }
  try {
    var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ secret: sec, items: [] }), muteHttpExceptions: true, followRedirects: true });
    var code = res.getResponseCode();
    Logger.log('push function answered HTTP ' + code + ': ' + String(res.getContentText()).slice(0, 160));
    Logger.log(code === 200 ? '=> The Netlify function is reachable and the secret is right.' : code === 401 ? '=> Wrong PUSH_SECRET: it must be the same text in setup() and in Netlify.' : code === 500 ? '=> Netlify is missing a variable (VAPID_PUBLIC, VAPID_PRIVATE or PUSH_SECRET). Add it, then upload the site folder again.' : code === 404 ? '=> The function was not found at PUSH_URL: check PUSH_SITE in setup() and that the functions folder was uploaded.' : '=> Unexpected answer; check PUSH_SITE in setup() and that the Netlify site is public.');
  } catch (e) { Logger.log('=> Could not reach PUSH_URL: ' + e); }
}
