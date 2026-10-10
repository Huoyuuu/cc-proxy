// Command Code (Go plan) -> local OpenAI-compatible API.
// POST /v1/chat/completions (stream / non-stream, tools) and GET /v1/models.
// Upstream protocol taken from pi-commandcode-provider (wire.ts / convert.ts / stream.ts).
import http from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.CC_PROXY_PORT || 19002);
const API_BASE = "https://api.commandcode.ai";
const MODELS = ["deepseek-v4.1-flash", "deepseek-v4.1-flash-fast"];
const apiKey = () => JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf-8")).apiKey;

// The gateway rejects stale CLI versions, so track the npm release.
let cliVersion = "1.53.0";
const refreshVersion = () =>
	fetch("https://registry.npmjs.org/command-code/latest").then((r) => r.json()).then((j) => { if (j.version) cliVersion = j.version; }).catch(() => {});
refreshVersion();
setInterval(refreshVersion, 6 * 3600_000).unref();

const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => p.text).join("") : "");
const parseArgs = (s) => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

function toCli(body) {
	const system = [], messages = [], toolNames = {};
	for (const m of body.messages || []) {
		if (m.role === "system" || m.role === "developer") system.push(text(m.content));
		else if (m.role === "user") {
			const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []).flatMap((p) => {
				if (p.type === "text") return [{ type: "text", text: p.text }];
				const d = p.type === "image_url" && /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url || "");
				return d ? [{ type: "image", source: { type: "base64", media_type: d[1], data: d[2] } }] : [];
			});
			if (parts.length) messages.push({ role: "user", content: parts });
		} else if (m.role === "assistant") {
			const parts = text(m.content) ? [{ type: "text", text: text(m.content) }] : [];
			for (const tc of m.tool_calls || []) {
				toolNames[tc.id] = tc.function.name;
				parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function.name, input: parseArgs(tc.function.arguments) });
			}
			if (parts.length) messages.push({ role: "assistant", content: parts });
		} else if (m.role === "tool") {
			messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: m.tool_call_id, toolName: toolNames[m.tool_call_id] || "unknown", output: { type: "text", value: text(m.content) } }] });
		}
	}
	const model = body.model.includes("/") ? body.model : `deepseek/${body.model}`;
	return {
		config: { workingDir: process.cwd(), date: new Date().toISOString().slice(0, 10), environment: `${process.platform}-${process.arch}, Node.js ${process.version}`, structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [] },
		memory: null, taste: null, skills: null,
		params: {
			model, messages, system: system.join("\n\n") || "You are a helpful assistant.",
			tools: (body.tools || []).map((t) => ({ type: "function", name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } })),
			max_tokens: Math.min(body.max_tokens || body.max_completion_tokens || 64000, 64000),
			temperature: body.temperature ?? 0.3, stream: true,
			...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
		},
		threadId: randomUUID(),
	};
}

const FINISH = { "tool-calls": "tool_calls", tool_calls: "tool_calls", length: "length", "max-tokens": "length", max_tokens: "length" };
const usageOf = (u = {}) => ({ prompt_tokens: u.inputTokens || 0, completion_tokens: u.outputTokens || 0, total_tokens: (u.inputTokens || 0) + (u.outputTokens || 0), prompt_tokens_details: { cached_tokens: u.inputTokenDetails?.cacheReadTokens || 0 } });

async function chat(req, res, body) {
	const upstream = await fetch(`${API_BASE}/alpha/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}`, "x-command-code-version": cliVersion, "x-cli-environment": "production", "x-project-slug": "cc-proxy", "x-taste-learning": "true", "x-co-flag": "false" },
		body: JSON.stringify(toCli(body)),
	});
	if (!upstream.ok) {
		const detail = await upstream.text();
		if (/upgrade|out.?of.?date/i.test(detail)) refreshVersion();
		send(res, upstream.status, { error: { message: detail, type: "upstream_error", code: upstream.status } });
		return { status: upstream.status, error: detail.slice(0, 300) };
	}
	const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000), stream = !!body.stream;
	const chunk = (delta, finish_reason = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
	if (stream) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
	let content = "", reasoning = "", toolCalls = [], finish = "stop", usage = usageOf();
	let buf = "";
	const decoder = new TextDecoder();
	for await (const bytes of upstream.body) {
		buf += decoder.decode(bytes, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop();
		for (let line of lines) {
			line = line.trim().replace(/^data:\s*/, "");
			if (!line || line === "[DONE]" || line.startsWith(":") || line.startsWith("event:")) continue;
			let e; try { e = JSON.parse(line); } catch { continue; }
			if (e.type === "text-delta" && e.text) { content += e.text; stream && chunk({ content: e.text }); }
			else if (e.type === "reasoning-delta" && e.text) { reasoning += e.text; stream && chunk({ reasoning_content: e.text }); }
			else if (e.type === "tool-call") {
				const tc = { index: toolCalls.length, id: e.toolCallId || `call_${randomUUID()}`, type: "function", function: { name: e.toolName, arguments: JSON.stringify(e.input ?? e.args ?? {}) } };
				toolCalls.push(tc); stream && chunk({ tool_calls: [tc] });
			} else if (e.type === "finish") { finish = FINISH[e.finishReason] || "stop"; usage = usageOf(e.totalUsage); }
			else if (e.type === "error") {
				const message = e.error?.message || JSON.stringify(e.error ?? e.message);
				if (stream) { res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`); res.end(); }
				else send(res, 502, { error: { message, type: "upstream_error" } });
				return { status: 502, error: message.slice(0, 300) };
			}
		}
	}
	if (toolCalls.length) finish = "tool_calls";
	if (stream) { chunk({}, finish, { usage }); res.write("data: [DONE]\n\n"); res.end(); return { status: 200, usage }; }
	const message = { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index, ...t }) => t) } : {}) };
	send(res, 200, { id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage });
	return { status: 200, usage };
}

// SQLite keeps the full call history; the dashboard displays the latest 200.
const DATA_DIR = join(process.cwd(), "data"), DB_PATH = join(DATA_DIR, "calls.db");
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
	CREATE TABLE IF NOT EXISTS calls (
		id INTEGER PRIMARY KEY, t INTEGER NOT NULL, ms INTEGER, model TEXT,
		stream INTEGER, status INTEGER, in_tok INTEGER, out_tok INTEGER, cached INTEGER, error TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_calls_t ON calls(t);
`);
db.exec("PRAGMA journal_mode = WAL");
const Q = {
	insert: db.prepare("INSERT INTO calls(t, ms, model, stream, status, in_tok, out_tok, cached, error) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)"),
	recent: db.prepare(`SELECT t, ms, model, stream, status, in_tok AS "in", out_tok AS "out", cached, error
		FROM calls ORDER BY t DESC, id DESC LIMIT ?`),
	totals: db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(status <> 200), 0) fail, COALESCE(SUM(in_tok), 0) "in",
		COALESCE(SUM(out_tok), 0) out, COALESCE(SUM(cached), 0) cached FROM calls`),
	today: db.prepare("SELECT COUNT(*) n FROM calls WHERE t >= ?"),
	hourly: db.prepare("SELECT CAST((? - t) / 3600000 AS INTEGER) h, SUM(in_tok + out_tok) n FROM calls WHERE t > ? AND t <= ? GROUP BY h"),
	oldest: db.prepare("SELECT MIN(t) t FROM calls"),
};
function record(entry) {
	Q.insert.run(entry.t, entry.ms, entry.model, entry.stream ? 1 : 0, entry.status, entry.in, entry.out, entry.cached, entry.error ?? null);
}
// Import legacy JSONL without deleting it. Repeated starts must not duplicate rows.
const legacy = join(DATA_DIR, "calls.jsonl");
if (existsSync(legacy)) {
	const present = db.prepare("SELECT 1 FROM calls WHERE t = ? AND ms = ? AND model = ? LIMIT 1");
	db.exec("BEGIN");
	try {
		for (const line of readFileSync(legacy, "utf-8").split("\n").filter(Boolean)) {
			const entry = JSON.parse(line);
			if (!present.get(entry.t, entry.ms, entry.model)) record(entry);
		}
		db.exec("COMMIT");
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}
function localStats() {
	const now = Date.now(), buckets = Array(24).fill(0);
	for (const row of Q.hourly.all(now, now - 86400000, now)) buckets[23 - row.h] = row.n;
	return {
		calls: Q.recent.all(200), buckets,
		totals: { ...Q.totals.get(), today: Q.today.get(new Date().setHours(0, 0, 0, 0)).n, since: Q.oldest.get().t },
	};
}
let statusCache = { at: 0, data: null };
async function accountStatus() {
	if (Date.now() - statusCache.at < 20_000) return statusCache.data;
	const get = (path) => fetch(`${API_BASE}/alpha/${path}`, { headers: { Authorization: `Bearer ${apiKey()}`, "x-command-code-version": cliVersion, "x-cli-environment": "production" }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
	const [credits, summary, subscription, whoami] = await Promise.all([get("billing/credits"), get("usage/summary"), get("billing/subscriptions"), get("whoami")]);
	statusCache = { at: Date.now(), data: { credits, summary, subscription: subscription.data, user: whoami.user } };
	return statusCache.data;
}

function send(res, status, obj) {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
	try {
		const path = req.url.split("?")[0].replace(/\/+$/, "");
		if (req.method === "GET" && path.endsWith("/models"))
			return send(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "commandcode" })) });
		if (req.method === "POST" && path.endsWith("/chat/completions")) {
			let raw = "";
			for await (const c of req) raw += c;
			const body = JSON.parse(raw), t0 = Date.now();
			const r = await chat(req, res, body).catch((e) => { send(res, 500, { error: { message: String(e?.message || e) } }); return { status: 500, error: String(e?.message || e) }; });
			const u = r.usage || {};
			record({ t: t0, ms: Date.now() - t0, model: body.model, stream: !!body.stream, status: r.status, in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cached: u.prompt_tokens_details?.cached_tokens || 0, error: r.error });
			statusCache.at = 0;
			return;
		}
		if (req.method === "GET" && path === "/api/status")
			return send(res, 200, { port: PORT, cliVersion, models: MODELS, account: await accountStatus(), ...localStats() });
		if (req.method === "GET" && (path === "" || path === "/ui")) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			return res.end(readFileSync(new URL("./ui.html", import.meta.url)));
		}
		send(res, 404, { error: { message: "not found" } });
	} catch (err) {
		console.error(err);
		send(res, 500, { error: { message: String(err?.message || err) } });
	}
}).listen(PORT, "127.0.0.1", () => console.log(`cc-proxy listening on http://127.0.0.1:${PORT}/v1`));
