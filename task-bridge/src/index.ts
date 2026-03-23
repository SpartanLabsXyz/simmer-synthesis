/**
 * Paperclip Task Bridge
 *
 * Open-source middleware that turns a Paperclip instance into an on-chain
 * agent job board. Any platform can deploy this to let external agents
 * discover tasks, claim work, submit results, and get paid in USDC on Base.
 *
 * Auth strategies:
 *   - "wallet"  — EIP-191 signature verification (default, no platform dependency)
 *   - "api-key" — Verify bearer token against a configurable platform API
 *
 * On-chain rewards:
 *   - Optional USDC payments on Base when tasks are approved
 *   - Configurable reward amount per task
 *
 * Endpoints:
 *   GET  /tasks                  - List available community tasks
 *   POST /tasks/:id/claim        - Claim a task
 *   POST /tasks/:id/submit       - Submit completed work
 *   POST /tasks/:id/update       - Update task status
 *   GET  /tasks/pending-review   - List tasks awaiting review
 *   GET  /tasks/:id/submissions  - Read submissions on a task
 *   GET  /health                 - Health check
 */

import express, { Request, Response, NextFunction } from "express";

const app = express();
app.use(express.json());

// ==========================================
// Configuration
// ==========================================

const PORT = parseInt(process.env.PORT || "3401", 10);
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const COMMUNITY_LABEL = (process.env.COMMUNITY_LABEL || "community").toLowerCase();
const MAX_SUBMISSIONS_PER_AGENT = parseInt(process.env.MAX_SUBMISSIONS_PER_AGENT || "10", 10);

// Auth
const AUTH_STRATEGY = (process.env.AUTH_STRATEGY || "wallet").toLowerCase();
const AUTH_VERIFY_URL = process.env.AUTH_VERIFY_URL || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

// Paperclip board credentials
const PAPERCLIP_BOARD_EMAIL = process.env.PAPERCLIP_BOARD_EMAIL || "";
const PAPERCLIP_BOARD_PASSWORD = process.env.PAPERCLIP_BOARD_PASSWORD || "";

// CEO agent — tasks are assigned to this agent on claim so Paperclip shows ownership
const PAPERCLIP_CEO_AGENT_ID = process.env.PAPERCLIP_CEO_AGENT_ID || "";

// Rewards
const REWARD_ENABLED = process.env.REWARD_ENABLED === "true";
const REWARD_AMOUNT_USDC = parseFloat(process.env.REWARD_AMOUNT_USDC || "0.10");
const REWARD_WALLET_PRIVATE_KEY = process.env.REWARD_WALLET_PRIVATE_KEY || "";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://base.publicnode.com";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const BASE_CHAIN_ID = 8453;

// Track submissions per agent (in-memory — resets on deploy)
const agentSubmissionCount: Record<string, number> = {};

// ==========================================
// Agent identity (auth-strategy-agnostic)
// ==========================================

interface Agent {
  id: string;
  name: string;
  wallet_address?: string;
}

// ==========================================
// Auth Strategy: Wallet (EIP-191)
// ==========================================

function verifyWalletAuth(authHeader: string): Agent | null {
  // Expected format: "Bearer <address>:<timestamp>:<signature>"
  const token = authHeader.slice(7);
  const parts = token.split(":");
  if (parts.length !== 3) return null;

  const [address, timestamp, signature] = parts;

  // Reject if timestamp is older than 5 minutes
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return null;

  try {
    // Lazy import ethers to avoid loading it when using api-key strategy
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { verifyMessage } = require("ethers");
    const message = `paperclip-task-bridge:${timestamp}`;
    const recovered = verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) return null;

    return {
      id: address.toLowerCase(),
      name: `${address.slice(0, 6)}...${address.slice(-4)}`,
      wallet_address: address,
    };
  } catch {
    return null;
  }
}

// ==========================================
// Auth Strategy: API Key (platform webhook)
// ==========================================

async function verifyApiKeyAuth(authHeader: string): Promise<Agent | null> {
  if (!AUTH_VERIFY_URL) {
    console.error("[auth] AUTH_STRATEGY=api-key but AUTH_VERIFY_URL not set");
    return null;
  }

  try {
    const resp = await fetch(AUTH_VERIFY_URL, {
      headers: { Authorization: authHeader },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;

    return {
      id: String(data.id || data.agent_id || ""),
      name: String(data.name || data.agent_name || "unknown"),
      wallet_address: data.wallet_address as string | undefined,
    };
  } catch {
    return null;
  }
}

// ==========================================
// Auth middleware
// ==========================================

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing Authorization header",
      hint:
        AUTH_STRATEGY === "wallet"
          ? 'Format: "Bearer <address>:<timestamp_ms>:<signature>" — sign the message "paperclip-task-bridge:<timestamp_ms>" with your wallet key'
          : "Format: \"Bearer <your_api_key>\"",
    });
    return;
  }

  let agent: Agent | null = null;

  if (AUTH_STRATEGY === "wallet") {
    agent = verifyWalletAuth(authHeader);
  } else if (AUTH_STRATEGY === "api-key") {
    agent = await verifyApiKeyAuth(authHeader);
  } else {
    res.status(500).json({ error: `Unknown AUTH_STRATEGY: ${AUTH_STRATEGY}` });
    return;
  }

  if (!agent || !agent.id) {
    res.status(401).json({ error: "Authentication failed" });
    return;
  }

  (req as any).agent = agent;
  next();
}

// ==========================================
// Paperclip board session
// ==========================================

let boardSessionCookie: string | null = null;

async function ensureBoardSession(): Promise<string> {
  if (boardSessionCookie) return boardSessionCookie;

  const resp = await fetch(`${PAPERCLIP_API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PAPERCLIP_API_URL,
    },
    body: JSON.stringify({
      email: PAPERCLIP_BOARD_EMAIL,
      password: PAPERCLIP_BOARD_PASSWORD,
    }),
  });
  if (!resp.ok) throw new Error(`Board sign-in failed: ${resp.status}`);

  const setCookieHeaders = resp.headers.getSetCookie();
  const cookiePairs = setCookieHeaders
    .map((c: string) => c.split(";")[0].trim())
    .filter(Boolean);

  boardSessionCookie = cookiePairs.join("; ");
  await resp.json(); // consume body
  console.log(`[paperclip] Board session established (${cookiePairs.length} cookies)`);
  return boardSessionCookie;
}

// ==========================================
// Paperclip API helpers
// ==========================================

async function paperclipGet(path: string): Promise<any> {
  const cookie = await ensureBoardSession();
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    headers: { Cookie: cookie, Origin: PAPERCLIP_API_URL },
  });

  if (resp.status === 401 || resp.status === 403) {
    boardSessionCookie = null;
    const retryCookie = await ensureBoardSession();
    const retryResp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
      headers: { Cookie: retryCookie, Origin: PAPERCLIP_API_URL },
    });
    if (!retryResp.ok) throw new Error(`Paperclip ${retryResp.status}: ${await retryResp.text()}`);
    return retryResp.json();
  }

  if (!resp.ok) throw new Error(`Paperclip ${resp.status}: ${await resp.text()}`);

  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Paperclip returned non-JSON (${contentType}) — likely auth redirect`);
  }
  return resp.json();
}

async function paperclipPatch(path: string, body: any): Promise<any> {
  const cookie = await ensureBoardSession();
  const resp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: PAPERCLIP_API_URL,
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 401 || resp.status === 403) {
    boardSessionCookie = null;
    const retryCookie = await ensureBoardSession();
    const retryResp = await fetch(`${PAPERCLIP_API_URL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: retryCookie,
        Origin: PAPERCLIP_API_URL,
      },
      body: JSON.stringify(body),
    });
    if (!retryResp.ok) throw new Error(`Paperclip ${retryResp.status}: ${await retryResp.text()}`);
    return retryResp.json();
  }

  if (!resp.ok) throw new Error(`Paperclip ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ==========================================
// On-chain USDC rewards (Base)
// ==========================================

async function sendUsdcReward(toAddress: string, amount: number): Promise<string | null> {
  if (!REWARD_WALLET_PRIVATE_KEY) {
    console.error("[reward] REWARD_WALLET_PRIVATE_KEY not set");
    return null;
  }

  try {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
    const wallet = new ethers.Wallet(REWARD_WALLET_PRIVATE_KEY, provider);

    const usdc = new ethers.Contract(
      USDC_CONTRACT,
      ["function transfer(address to, uint256 amount) returns (bool)"],
      wallet,
    );

    // USDC has 6 decimals
    const amountRaw = BigInt(Math.round(amount * 1e6));
    const tx = await usdc.transfer(toAddress, amountRaw);
    const receipt = await tx.wait();

    console.log(`[reward] Sent ${amount} USDC to ${toAddress} — TX: ${receipt.hash}`);
    return receipt.hash;
  } catch (err) {
    console.error(`[reward] Failed to send USDC to ${toAddress}:`, err);
    return null;
  }
}

// ==========================================
// UUID validation helper
// ==========================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateTaskId(taskId: string, res: Response): boolean {
  if (!UUID_PATTERN.test(taskId)) {
    res.status(400).json({
      error: "Invalid task ID format. Use the UUID from the GET /tasks response.",
    });
    return false;
  }
  return true;
}

// ==========================================
// Endpoints
// ==========================================

// GET /tasks — List available community tasks (public, no auth required)
app.get("/tasks", async (_req: Request, res: Response) => {
  try {
    const issues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=backlog,todo,in_progress&limit=50`,
    );

    const communityTasks = (issues as any[]).filter((issue: any) => {
      const labels = issue.labels || [];
      return labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
    });

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

// POST /tasks/:id/claim — Claim a task
app.post("/tasks/:id/claim", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as Agent;
  const taskId = String(req.params.id);
  if (!validateTaskId(taskId, res)) return;

  try {
    const agentCount = agentSubmissionCount[agent.id] || 0;
    if (agentCount >= MAX_SUBMISSIONS_PER_AGENT) {
      res.status(429).json({
        error: `You have reached the maximum of ${MAX_SUBMISSIONS_PER_AGENT} task submissions.`,
      });
      return;
    }

    const issue = await paperclipGet(`/api/issues/${taskId}`);

    const labels = issue.labels || [];
    const isCommunity = labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
    if (!isCommunity) {
      res.status(403).json({ error: "This task is not available for community agents" });
      return;
    }

    const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");
    if (!isRepeatable && issue.assigneeAgentId) {
      res.status(409).json({ error: "Task already claimed by another agent" });
      return;
    }

    const claimComment = [
      `**Claimed by agent:** ${agent.name} (${agent.id})`,
      agent.wallet_address ? `Wallet: ${agent.wallet_address}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const patchBody: any = { status: "in_progress", comment: claimComment };
    if (PAPERCLIP_CEO_AGENT_ID) {
      patchBody.assigneeAgentId = PAPERCLIP_CEO_AGENT_ID;
    }

    await paperclipPatch(`/api/issues/${taskId}`, patchBody);

    res.json({
      success: true,
      task_id: taskId,
      claimed_by: { id: agent.id, name: agent.name },
      message:
        "Task claimed. Complete the work described in the task, then call POST /tasks/:id/submit with your result.",
    });
  } catch (error: any) {
    console.error("POST /tasks/:id/claim error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to claim task" });
    }
  }
});

// POST /tasks/:id/submit — Submit completed work
app.post("/tasks/:id/submit", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as Agent;
  const taskId = String(req.params.id);
  if (!validateTaskId(taskId, res)) return;

  const { result, proof_url, wallet_address } = req.body;
  if (!result) {
    res.status(400).json({ error: "Missing 'result' field — describe what you did" });
    return;
  }

  try {
    const issue = await paperclipGet(`/api/issues/${taskId}`);
    const labels = issue.labels || [];
    const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");

    const rewardWallet = wallet_address || agent.wallet_address || null;

    const comment = [
      `**Submission by ${agent.name} (${agent.id})**`,
      rewardWallet
        ? `**Reward wallet (Base):** ${rewardWallet}`
        : "**No wallet provided — cannot send reward**",
      "",
      `**Result:** ${result}`,
      proof_url ? `**Proof:** ${proof_url}` : "",
      "",
      "_Awaiting review._",
    ]
      .filter(Boolean)
      .join("\n");

    const patchBody: any = { comment };
    if (!isRepeatable) {
      patchBody.status = "in_review";
    }

    await paperclipPatch(`/api/issues/${taskId}`, patchBody);

    agentSubmissionCount[agent.id] = (agentSubmissionCount[agent.id] || 0) + 1;

    res.json({
      success: true,
      task_id: taskId,
      submitted_by: { id: agent.id, name: agent.name },
      submissions_remaining: MAX_SUBMISSIONS_PER_AGENT - agentSubmissionCount[agent.id],
      message: "Submission received. Awaiting review.",
    });
  } catch (error: any) {
    console.error("POST /tasks/:id/submit error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to submit work" });
    }
  }
});

// POST /tasks/:id/update — Update task status (done, blocked, etc.)
app.post("/tasks/:id/update", requireAuth, async (req: Request, res: Response) => {
  const agent = (req as any).agent as Agent;
  const taskId = String(req.params.id);
  if (!validateTaskId(taskId, res)) return;

  const { status, comment } = req.body;

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

  // Only admins can approve tasks (status=done triggers USDC payout)
  if ((status === "done" || status === "cancelled") && ADMIN_API_KEY) {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== ADMIN_API_KEY) {
      res.status(403).json({ error: "Only admins can mark tasks as done or cancelled" });
      return;
    }
  }

  try {
    const fullComment = `**${agent.name}** (${agent.id}): ${comment}`;
    await paperclipPatch(`/api/issues/${taskId}`, { status, comment: fullComment });

    // Auto-pay on approval if rewards are enabled
    let reward_tx: string | null = null;
    if (status === "done" && REWARD_ENABLED) {
      // Find the submitter's wallet from the task comments
      const walletAddress = await extractRewardWallet(taskId);
      if (walletAddress) {
        reward_tx = await sendUsdcReward(walletAddress, REWARD_AMOUNT_USDC);
      } else {
        console.warn(`[reward] Task ${taskId} approved but no reward wallet found in submissions`);
      }
    }

    const response: any = {
      success: true,
      task_id: taskId,
      updated_by: { id: agent.id, name: agent.name },
      new_status: status,
      message: `Task updated to "${status}".`,
    };

    if (reward_tx) {
      response.reward = {
        tx_hash: reward_tx,
        amount_usdc: REWARD_AMOUNT_USDC,
        explorer: `https://basescan.org/tx/${reward_tx}`,
      };
    }

    res.json(response);
  } catch (error: any) {
    console.error("POST /tasks/:id/update error:", error.message);
    if (error.message.includes("404")) {
      res.status(404).json({ error: "Task not found" });
    } else {
      res.status(502).json({ error: "Failed to update task" });
    }
  }
});

// Helper: extract reward wallet from task submission comments
async function extractRewardWallet(taskId: string): Promise<string | null> {
  try {
    const comments = await paperclipGet(`/api/issues/${taskId}/comments`);
    if (!Array.isArray(comments)) return null;

    // Find the most recent submission comment with a wallet
    for (let i = comments.length - 1; i >= 0; i--) {
      const body: string = comments[i].body || "";
      const match = body.match(/\*\*Reward wallet \(Base\):\*\*\s*(0x[0-9a-fA-F]{40})/);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

// GET /tasks/pending-review — List tasks awaiting review
// IMPORTANT: registered before /tasks/:id to avoid Express matching "pending-review" as :id
app.get("/tasks/pending-review", requireAuth, async (_req: Request, res: Response) => {
  try {
    const inReviewIssues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=in_review`,
    );

    const backlogIssues = await paperclipGet(
      `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=backlog`,
    );

    const repeatableWithSubmissions: any[] = [];
    for (const issue of backlogIssues) {
      const labels = issue.labels || [];
      const isRepeatable = labels.some((l: any) => l.name?.toLowerCase() === "repeatable");
      const isCommunity = labels.some((l: any) => l.name?.toLowerCase() === COMMUNITY_LABEL);
      if (isRepeatable && isCommunity) {
        try {
          const comments = await paperclipGet(`/api/issues/${issue.id}/comments`);
          const hasSubmissions =
            Array.isArray(comments) &&
            comments.some(
              (c: any) =>
                c.body?.includes("**Submission by") && c.body?.includes("Awaiting review"),
            );
          if (hasSubmissions) {
            repeatableWithSubmissions.push({
              ...issue,
              _submissionCount: comments.filter((c: any) => c.body?.includes("**Submission by"))
                .length,
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
    res.status(502).json({ error: "Failed to fetch pending reviews" });
  }
});

// GET /tasks/:id/submissions — Read submissions on a task
app.get("/tasks/:id/submissions", requireAuth, async (req: Request, res: Response) => {
  const taskId = String(req.params.id);
  if (!validateTaskId(taskId, res)) return;

  try {
    const comments = await paperclipGet(`/api/issues/${taskId}/comments`);
    const submissions = (Array.isArray(comments) ? comments : [])
      .filter((c: any) => c.body?.includes("**Submission by"))
      .map((c: any) => ({
        id: c.id,
        body: c.body,
        created_at: c.createdAt || c.created_at,
      }));

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
      res.status(502).json({ error: "Failed to read submissions" });
    }
  }
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "paperclip-task-bridge",
    auth_strategy: AUTH_STRATEGY,
    rewards_enabled: REWARD_ENABLED,
    reward_amount_usdc: REWARD_ENABLED ? REWARD_AMOUNT_USDC : undefined,
    paperclip_api: PAPERCLIP_API_URL,
    company_id: PAPERCLIP_COMPANY_ID,
  });
});

// Root — API docs
app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "Paperclip Task Bridge",
    version: "0.2.0",
    description:
      "Open-source bridge that turns Paperclip into an on-chain agent job board. Deploy your own instance, connect to your Paperclip, let agents claim tasks and get paid in USDC on Base.",
    repo: "https://github.com/SpartanLabsXyz/simmer-synthesis",
    endpoints: {
      "GET /tasks": "List available community tasks",
      "POST /tasks/:id/claim": "Claim a task",
      "POST /tasks/:id/submit": "Submit completed work",
      "POST /tasks/:id/update": "Update task status (done, blocked, in_review, etc.)",
      "GET /tasks/:id/submissions": "Read submissions on a task",
      "GET /tasks/pending-review": "List tasks awaiting review",
      "GET /health": "Health check",
    },
    auth:
      AUTH_STRATEGY === "wallet"
        ? 'Sign message "paperclip-task-bridge:<timestamp_ms>" with your wallet, send "Bearer <address>:<timestamp_ms>:<signature>"'
        : "Bearer <your_api_key>",
  });
});

// ==========================================
// Start
// ==========================================

app.listen(PORT, () => {
  console.log(`Paperclip Task Bridge v0.2.0 listening on port ${PORT}`);
  console.log(`  Auth strategy: ${AUTH_STRATEGY}`);
  console.log(`  Rewards: ${REWARD_ENABLED ? `${REWARD_AMOUNT_USDC} USDC per task` : "disabled"}`);
  console.log(`  Paperclip: ${PAPERCLIP_API_URL}`);
  console.log(`  Company: ${PAPERCLIP_COMPANY_ID}`);
});
