// Auth acceptance test (SOW §6.1, §7): sign-up, sign-in, sessions, friend codes.
// Needs a server running WITH a database, e.g.:
//   node --env-file=.env dist/server/index.js
// The lobby itself (WebSocket + onAuth) is verified in the browser, since the
// session rides in a cookie on the WS handshake.
const ENDPOINT = "http://localhost:2567";
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// Node's fetch doesn't keep cookies; capture Set-Cookie and echo it back.
const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];
// A browser sends its real Origin, which Better Auth checks against
// trustedOrigins. Node's fetch sends "Origin: null" (rejected), so we send the
// real one explicitly to mirror a browser request.
const JSON_HEADERS = { "Content-Type": "application/json", Origin: ENDPOINT };

const email = `t${Date.now()}${Math.floor(Math.random() * 1000)}@test.com`;
const password = "hunter2pass";

// ---- config advertises auth
const cfg = await fetch(`${ENDPOINT}/api/config`).then((r) => r.json());
check("the server advertises auth is enabled", cfg.auth === true);

// ---- sign up
const suRes = await fetch(`${ENDPOINT}/api/auth/sign-up/email`, {
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify({ email, password, name: "Tester" }),
});
const su = await suRes.json();
check("sign-up succeeds", suRes.status === 200 && !!su.user, `HTTP ${suRes.status}`);
check("sign-up mints a friend code", /^CLUE-[2-9A-Z]{4}$/.test(su.user?.friendCode ?? ""), su.user?.friendCode);
const cookie = cookieOf(suRes);
check("sign-up sets a session cookie", !!cookie);

// ---- the session resolves back to the user
const sess = await fetch(`${ENDPOINT}/api/auth/get-session`, {
  headers: { cookie, Origin: ENDPOINT },
}).then((r) => r.json());
check("the session resolves to the signed-up user", sess?.user?.email === email);
check("the session carries the friend code", sess?.user?.friendCode === su.user?.friendCode);

// ---- wrong password is rejected
const bad = await fetch(`${ENDPOINT}/api/auth/sign-in/email`, {
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify({ email, password: "not-the-password" }),
});
check("a wrong password is rejected", bad.status === 401, `HTTP ${bad.status}`);

// ---- sign in returns the same account + friend code
const inRes = await fetch(`${ENDPOINT}/api/auth/sign-in/email`, {
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify({ email, password }),
});
const si = await inRes.json();
check("sign-in with the right password succeeds", inRes.status === 200 && !!si.user, `HTTP ${inRes.status}`);
check("the friend code is stable across sign-ins", si.user?.friendCode === su.user?.friendCode);

// ---- duplicate email can't sign up twice
const dupe = await fetch(`${ENDPOINT}/api/auth/sign-up/email`, {
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify({ email, password, name: "Imposter" }),
});
check("the same email can't register twice", dupe.status >= 400, `HTTP ${dupe.status}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
