#!/usr/bin/env node
/**
 * OpenScience Local Skills Sync (v2)
 *
 * Pulls skills from the running server and saves/updates them locally.
 * Since GET /skill doesn't return content, we read from the location paths.
 *
 * Usage:
 *   node sync-skills.js pull   # server → local
 *   node sync-skills.js push   # local → server
 *   node sync-skills.js diff   # compare
 *   node sync-skills.js status # counts
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const API_URL = process.argv[2] || "http://127.0.0.1:4096";
const LOCAL_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  ".local", "share", "openscience", "local-skills"
);
const ACTION = process.argv[3] || "pull";

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_URL}${urlPath}`);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname, timeout: 30_000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    }).on("error", reject);
  });
}

function httpPut(name, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content });
    const url = new URL(`${API_URL}/skill/${encodeURIComponent(name)}`);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 60_000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── file helpers ─────────────────────────────────────────────────────────────

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

function saveLocal(skill) {
  const dir = path.join(LOCAL_DIR, skill.category || "unknown", skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skill.content, "utf8");
}

function readLocal(name) {
  if (!fs.existsSync(LOCAL_DIR)) return null;
  for (const cat of fs.readdirSync(LOCAL_DIR)) {
    const file = path.join(LOCAL_DIR, cat, name, "SKILL.md");
    if (fs.existsSync(file)) {
      return { file, content: readSafe(file), category: cat };
    }
  }
  return null;
}

function listLocalSkills() {
  const results = [];
  if (!fs.existsSync(LOCAL_DIR)) return results;
  for (const cat of fs.readdirSync(LOCAL_DIR)) {
    const catDir = path.join(LOCAL_DIR, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const name of fs.readdirSync(catDir)) {
      const file = path.join(catDir, name, "SKILL.md");
      if (fs.existsSync(file)) {
        results.push({ name, category: cat, file, content: readSafe(file) });
      }
    }
  }
  return results;
}

// ── actions ──────────────────────────────────────────────────────────────────

async function pull() {
  console.log("Fetching skill list from server...");
  const data = await httpGet("/skill");
  const serverSkills = data.items || data;
  console.log(`Server has ${serverSkills.length} skills`);

  let added = 0, updated = 0, unchanged = 0, missing = 0;
  for (const sk of serverSkills) {
    // Read content from the server's file path
    const serverContent = readSafe(sk.location);
    if (!serverContent) {
      missing++;
      continue;
    }

    const local = readLocal(sk.name);
    if (!local) {
      saveLocal({ ...sk, content: serverContent });
      added++;
    } else if (local.content !== serverContent) {
      saveLocal({ ...sk, content: serverContent });
      updated++;
    } else {
      unchanged++;
    }
    process.stdout.write(".");
  }

  console.log(`\n\nPull complete:`);
  console.log(`  Added:     ${added}`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Missing:   ${missing}`);
  console.log(`  Local dir: ${LOCAL_DIR}`);
}

async function push() {
  console.log("Scanning local skills...");
  const locals = listLocalSkills();
  console.log(`Found ${locals.length} local skills`);

  let pushed = 0, failed = 0;
  for (const sk of locals) {
    const res = await httpPut(sk.name, sk.content);
    if (res.status >= 200 && res.status < 300) {
      pushed++;
      process.stdout.write(".");
    } else {
      failed++;
      console.log(`\n  FAIL ${sk.name}: ${res.status} ${res.body?.slice(0, 100)}`);
    }
  }
  console.log(`\n\nPush complete: ${pushed} pushed, ${failed} failed`);
}

async function diff() {
  console.log("Comparing server vs local...\n");
  const data = await httpGet("/skill");
  const serverSkills = data.items || data;
  const serverMap = new Map(serverSkills.map((s) => [s.name, s]));
  const locals = listLocalSkills();
  const localMap = new Map(locals.map((s) => [s.name, s]));

  const serverOnly = [...serverMap.keys()].filter((n) => !localMap.has(n));
  const localOnly = [...localMap.keys()].filter((n) => !serverMap.has(n));
  const both = [...serverMap.keys()].filter((n) => localMap.has(n));

  let different = 0, identical = 0;
  for (const n of both) {
    const serverContent = readSafe(serverMap.get(n).location);
    const localContent = localMap.get(n).content;
    if (serverContent && serverContent !== localContent) different++;
    else identical++;
  }

  console.log(`Server: ${serverSkills.length} | Local: ${locals.length}`);
  console.log(`\nServer-only (not local): ${serverOnly.length}`);
  serverOnly.forEach((n) => console.log(`  + ${n}`));
  console.log(`\nLocal-only (not server): ${localOnly.length}`);
  localOnly.forEach((n) => console.log(`  - ${n}`));
  console.log(`\nDifferent content: ${different}`);
  console.log(`Identical: ${identical}`);
}

async function status() {
  const data = await httpGet("/skill");
  const serverCount = (data.items || data).length;
  const localCount = listLocalSkills().length;
  console.log(`Server: ${serverCount} skills`);
  console.log(`Local:  ${localCount} skills`);
  console.log(`Source: ${LOCAL_DIR}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const actions = { pull, push, diff, status };
const fn = actions[ACTION];
if (!fn) {
  console.error(`Unknown action: ${ACTION}`);
  console.error("Usage: node sync-skills.js [pull|push|diff|status]");
  process.exit(1);
}
fn().catch((err) => { console.error("Error:", err.message); process.exit(1); });
