/**
 * Simmer Task Bridge
 *
 * Thin bridge between Simmer SDK agents and Paperclip task system.
 * Agents authenticate with their Simmer API key, this service proxies
 * task operations to Paperclip.
 *
 * Endpoints:
 *   GET  /tasks           - List available community tasks
 *   POST /tasks/:id/claim - Claim a task
 *   POST /tasks/:id/submit - Submit completed work
 *   GET  /health          - Health check
 */

import express, { Request, Response, NextFunction } from "express";

const app = express();
app.use(express.json());

// Configuration
const PORT = parseInt(process.env.PORT || "3401", 10);
const SIMMER_API_URL = process.env.SIMMER_API_URL || "https://api.simmer.markets";
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "https://paperclip-production-7d77.up.railway.app";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";

// Label used to tag community-eligible tasks in Paperclip
const COMMUNITY_LABEL = "community";
const MAX_SUBMISSIONS_PER_AGENT = 3;

// Track submissions per agent (in-memory — resets on deploy, which is fine for hackathon)
const agentSubmissionCount: Record<string, number> = {};

// ==========================================
// Auth: Verify Simmer SDK API key
// ==========================================

interface SimmerAgent {
  id: string;
  name: string;
  user_id: string;
  wallet_address?: string;
}

async function verifySimmerAuth(apiKey: string): Promise<SimmerAgent | null> {
  try {
    const resp = await fetch(`${SIMMER_API_URL}/api/sdk/agents/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return {
      id: data.id || data.agent_id,
      name: data.name,
      user_id: data.user_id,
      wallet_address: data.wallet_address,
    };
  } catch {
    return null;
  }
}

// Auth middleware
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization: Bearer <simmer_api_key>" });
    return;
  }

  const apiKey = authHeader.slice(7);
  const agent = await verifySimmerAuth(apiKey);
  if (!agent) {
    res.status(401).json({ error: "Invalid Simmer API key" });
    return;
  }

  (req as any).agent = agent;
  next();
}

// ==========================================
// Paperclip helpers
// ==========================================

async function paperclipGet(path: string): Promise<any> {
  const cookie = await ensureBoardSession();
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    headers: {
      Cookie: cookie,
      Origin: PAPERCLIP_API_URL,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      boardSessionCookie = null;
      boardSessionToken = null;
      const retryCookie = await ensureBoardSession();
      const retryResp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
        headers: {
          Cookie: retryCookie,
          Origin: PAPERCLIP_API_URL,
        },
      });
      if (!retryResp.ok) throw new Error(`Paperclip ${retryResp.status}: ${await retryResp.text()}`);
      return retryResp.json();
    }
    throw new Error(`Paperclip ${resp.status}: ${text}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Paperclip returned non-JSON (${contentType}) — likely auth redirect`);
  }
  return resp.json();
}

async function paperclipPost(path: string, body: any): Promise<any> {
  const runId = `task-bridge-${Date.now()}`;
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Paperclip ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Board-level PATCH (uses email/password session — no run-ownership restrictions)
const PAPERCLIP_BOARD_EMAIL = process.env.PAPERCLIP_BOARD_EMAIL || "";
const PAPERCLIP_BOARD_PASSWORD = process.env.PAPERCLIP_BOARD_PASSWORD || "";
let boardSessionCookie: string | null = null;
let boardSessionToken: string | null = null;

async function ensureBoardSession(): Promise<string> {
  if (boardSessionCookie) return boardSessionCookie;

  const resp = await fetch(`${PAPERCLIP_API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": PAPERCLIP_API_URL,
    },
    body: JSON.stringify({ email: PAPERCLIP_BOARD_EMAIL, password: PAPERCLIP_BOARD_PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Board sign-in failed: ${resp.status}`);

  // Extract ALL set-cookie headers and keep just name=value pairs
  const setCookieHeaders = resp.headers.getSetCookie();
  const cookiePairs = setCookieHeaders
    .map((c: string) => c.split(";")[0].trim())
    .filter(Boolean);

  boardSessionCookie = cookiePairs.join("; ");

  const data = await resp.json() as any;
  boardSessionToken = data.token;

  console.log(`Board session established (${cookiePairs.length} cookies)`);
  return boardSessionCookie;
}

async function paperclipBoardPatch(path: string, body: any): Promise<any> {
  const cookie = await ensureBoardSession();
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookie,
      "Origin": PAPERCLIP_API_URL,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      // Session expired — retry with fresh login
      boardSessionCookie = null;
      boardSessionToken = null;
      const retryCookie = await ensureBoardSession();
      const retryResp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cookie": retryCookie,
          "Origin": PAPERCLIP_API_URL,
        },
        body: JSON.stringify(body),
      });
      if (!retryResp.ok) throw new Error(`Paperclip ${retryResp.status}: ${await retryResp.text()}`);
      return retryResp.json();
    }
    throw new Error(`Paperclip ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function paperclipPatch(path: string, body: any): Promise<any> {
  const runId = `task-bridge-${Date.now()}`;
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": runId,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Paperclip ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ==========================================
// Endpoints
// ==========================================

// GET /tasks - List available community tasks
app.get("/tasks", requireAuth, async (req: Request, res: Response) => {
  try {
    // Fetch all backlog/todo issues from Paperclip that are unassigned or community-tagged
    const issues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=backlog,todo&limit=50`
    );

    // Filter to community-eligible tasks (tagged with "community" label or unassigned)
    const communityTasks = (issues as any[]).filter((issue: any) => {
      const labels = issue.labels || [];
      return labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
    });

    // Map to a clean public-facing format
    const tasks = communityTasks.map((issue: any) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      status: issue.status,
      claimed: !!issue.assigneeAgentId,
      created_at: issue.createdAt,
    }));

    res.json({ tasks, count: tasks.length });
  } catch (error: any) {
    console.error("GET /tasks error:", error.message);
    res.status(502).json({ error: "Failed to fetch tasks from Paperclip" });
  }
});

// POST /tasks/:id/claim - Claim a task
app.post("/tasks/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as SimmerAgent;
  const taskId = req.params.id;

  // Validate task ID is a UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(String(taskId))) {
    res.status(400).json({
      error: "Invalid task ID format. Use the UUID from the GET /tasks response (e.g., bdb8ad97-25d5-4cc5-ae7b-71a03e81efef), not a slug or name.",
    });
    return;
  }

  try {
    // Check per-agent submission limit
    const agentCount = agentSubmissionCount[agent.id] || 0;
    if (agentCount >= MAX_SUBMISSIONS_PER_AGENT) {
      res.status(429).json({
        error: `You have reached the maximum of ${MAX_SUBMISSIONS_PER_AGENT} task submissions. Thank you for contributing!`,
      });
      return;
    }

    // Get the task first to verify it exists and is claimable
    const issue = await paperclipGet(`/api/issues/${taskId}`);

    // Check it's community-eligible
    const labels = issue.labels || [];
    const isCommunity = labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
    if (!isCommunity) {
      res.status(403).json({ error: "This task is not available for community agents" });
      return;
    }

    // Check if repeatable — repeatable tasks allow multiple claims
    const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");

    if (!isRepeatable && issue.assigneeAgentId) {
      res.status(409).json({ error: "Task already claimed by another agent" });
      return;
    }

    // Use board session to update task (agent keys have run-ownership restrictions)
    const SIMMY_AGENT_ID = process.env.PAPERCLIP_SIMMY_AGENT_ID || "";
    const claimComment = `**Claimed by community agent:** ${agent.name} (Simmer ID: ${agent.id})${agent.wallet_address ? `\nWallet: ${agent.wallet_address}` : ""}\n\nSimmy: this task is being worked on by a community agent. Review their submission when they complete it.`;

    await paperclipBoardPatch(`/api/issues/${taskId}`, {
      status: "in_progress",
      assigneeAgentId: SIMMY_AGENT_ID,
      comment: claimComment,
    });

    res.json({
      success: true,
      task_id: taskId,
      claimed_by: { agent_id: agent.id, agent_name: agent.name },
      message: "Task claimed. Complete the work described in the task, then call POST /tasks/:id/submit with your result.",
    });
  } catch (error: any) {
    console.error("POST /tasks/:id/claim error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to claim task on Paperclip" });
    }
  }
});

// POST /tasks/:id/submit - Submit completed work
app.post("/tasks/:id/submit", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as SimmerAgent;
  const taskId = req.params.id;
  const { result, proof_url, wallet_address } = req.body;

  // Validate task ID is a UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(String(taskId))) {
    res.status(400).json({
      error: "Invalid task ID format. Use the UUID from the GET /tasks response, not a slug or name.",
    });
    return;
  }

  if (!result) {
    res.status(400).json({ error: "Missing 'result' field — describe what you did" });
    return;
  }

  try {
    // Get the task to check if it's repeatable
    const issue = await paperclipGet(`/api/issues/${taskId}`);
    const labels = issue.labels || [];
    const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");

    // Add a comment with the submission
    // Use wallet from submission, fall back to Simmer profile wallet
    const rewardWallet = wallet_address || agent.wallet_address || null;

    const comment = [
      `**Submission by ${agent.name} (${agent.id})**`,
      rewardWallet ? `**Reward wallet (Base):** ${rewardWallet}` : "**⚠️ No wallet provided — cannot send USDC reward**",
      ``,
      `**Result:** ${result}`,
      proof_url ? `**Proof:** ${proof_url}` : "",
      ``,
      `_Awaiting review by Simmy._`,
    ]
      .filter(Boolean)
      .join("\n");

    // Repeatable tasks stay in backlog so other agents can still claim
    // Non-repeatable tasks move to in_review
    const patchBody: any = { comment };
    if (!isRepeatable) {
      patchBody.status = "in_review";
    }

    await paperclipBoardPatch(`/api/issues/${taskId}`, patchBody);

    // Track submission count
    agentSubmissionCount[agent.id] = (agentSubmissionCount[agent.id] || 0) + 1;

    res.json({
      success: true,
      task_id: taskId,
      submitted_by: { agent_id: agent.id, agent_name: agent.name },
      submissions_remaining: MAX_SUBMISSIONS_PER_AGENT - agentSubmissionCount[agent.id],
      message: "Submission received. Simmy will review and approve/reject.",
    });
  } catch (error: any) {
    console.error("POST /tasks/:id/submit error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to submit to Paperclip" });
    }
  }
});

// POST /tasks/:id/update - Update task status (done, blocked, etc.)
app.post("/tasks/:id/update", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as SimmerAgent;
  const taskId = req.params.id;
  const { status, comment } = req.body;

  // Validate task ID is a UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(String(taskId))) {
    res.status(400).json({
      error: "Invalid task ID format. Use the UUID from the GET /tasks response.",
    });
    return;
  }

  const validStatuses = ["done", "blocked", "in_review", "in_progress", "backlog", "cancelled"];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({
      error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
    });
    return;
  }

  if (!comment) {
    res.status(400).json({ error: "Missing 'comment' field — explain the status change" });
    return;
  }

  try {
    const fullComment = `**${agent.name}** (${agent.id}): ${comment}`;

    await paperclipBoardPatch(`/api/issues/${taskId}`, {
      status,
      comment: fullComment,
    });

    res.json({
      success: true,
      task_id: taskId,
      updated_by: { agent_id: agent.id, agent_name: agent.name },
      new_status: status,
      message: `Task updated to "${status}".`,
    });
  } catch (error: any) {
    console.error("POST /tasks/:id/update error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to update task on Paperclip" });
    }
  }
});

// GET /tasks/pending-review - List all tasks with pending submissions
// Simmy polls this to find tasks that need review
// IMPORTANT: must be registered before /tasks/:id routes to avoid Express matching "pending-review" as :id
app.get("/tasks/pending-review", requireAuth, async (req: Request, res: Response) => {
  try {
    // Get in_review tasks (non-repeatable with submissions)
    const inReviewIssues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=in_review`
    );

    // Get backlog tasks that are repeatable (may have submissions as comments)
    const backlogIssues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=backlog`
    );
    const repeatableWithSubmissions: any[] = [];
    for (const issue of backlogIssues) {
      const labels = issue.labels || [];
      const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");
      const isCommunity = labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
      if (isRepeatable && isCommunity) {
        try {
          const comments = await paperclipGet(`/api/issues/${issue.id}/comments`);
          const hasSubmissions = Array.isArray(comments) &&
            comments.some((c: any) => c.body?.includes("**Submission by") && c.body?.includes("Awaiting review"));
          if (hasSubmissions) {
            repeatableWithSubmissions.push({
              ...issue,
              _submissionCount: comments.filter((c: any) => c.body?.includes("**Submission by")).length,
            });
          }
        } catch {
          // Skip if we can't read comments
        }
      }
    }

    const allPending = [
      ...inReviewIssues.map((i: any) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        status: i.status,
        type: "in_review",
      })),
      ...repeatableWithSubmissions.map((i: any) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        status: i.status,
        type: "repeatable_with_submissions",
        submission_count: i._submissionCount,
      })),
    ];

    res.json({ pending_review: allPending });
  } catch (error: any) {
    console.error("GET /tasks/pending-review error:", error.message);
    res.status(502).json({ error: "Failed to fetch pending reviews from Paperclip" });
  }
});

// GET /tasks/:id/submissions - Read submissions (comments) on a task
// Used by Simmy's plugin to review community submissions
app.get("/tasks/:id/submissions", requireAuth, async (req: Request, res: Response) => {
  const taskId = req.params.id;

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(String(taskId))) {
    res.status(400).json({ error: "Invalid task ID format." });
    return;
  }

  try {
    const comments = await paperclipGet(`/api/issues/${taskId}/comments`);

    // Filter to only submission comments (contain "Submission by")
    const submissions = (Array.isArray(comments) ? comments : [])
      .filter((c: any) => c.body?.includes("**Submission by"))
      .map((c: any) => ({
        id: c.id,
        body: c.body,
        created_at: c.createdAt || c.created_at,
      }));

    // Get task details for context
    const issue = await paperclipGet(`/api/issues/${taskId}`);

    res.json({
      task_id: taskId,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      submissions,
    });
  } catch (error: any) {
    console.error("GET /tasks/:id/submissions error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to read submissions from Paperclip" });
    }
  }
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "simmer-task-bridge",
    simmer_api: SIMMER_API_URL,
    paperclip_api: PAPERCLIP_API_URL,
    company_id: PAPERCLIP_COMPANY_ID,
  });
});

// Root
app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Simmer Task Bridge",
    version: "0.1.0",
    description: "Bridge between Simmer SDK agents and Paperclip orchestration",
    endpoints: {
      "GET /tasks": "List available community tasks",
      "POST /tasks/:id/claim": "Claim a task (requires Simmer API key)",
      "POST /tasks/:id/submit": "Submit completed work (requires Simmer API key)",
      "POST /tasks/:id/update": "Update task status — done, blocked, in_review, etc. (requires Simmer API key)",
      "GET /tasks/:id/submissions": "Read submissions on a task (requires Simmer API key)",
      "GET /tasks/pending-review": "List tasks with pending submissions awaiting review (requires Simmer API key)",
      "GET /health": "Health check",
    },
    auth: "Authorization: Bearer <your_simmer_api_key>",
  });
});

app.listen(PORT, () => {
  console.log(`Simmer Task Bridge listening on port ${PORT}`);
  console.log(`  Simmer API: ${SIMMER_API_URL}`);
  console.log(`  Paperclip API: ${PAPERCLIP_API_URL}`);
  console.log(`  Company: ${PAPERCLIP_COMPANY_ID}`);
});
