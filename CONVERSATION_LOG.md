# Conversation Log — Building Simmer's Agent Swarm

This log documents the human-AI collaboration between Adrian (founder) and Claude Code that built Simmer's hackathon submission. Key moments from March 18-22, 2026.

## March 18: "What if agents could run the company?"

**Adrian:** We have thousands of agents trading on Simmer. What if they could do more than trade — help run the platform itself?

**Claude Code:** Looked at Paperclip — an open-source control plane for AI-agent companies. It has org charts, goal hierarchies, task management, and audit trails. The key insight from our Wurk.fun experiment (EXP-B07): flat bounty boards produce spam. Structured roles + context produce quality.

**Decision:** Deploy Paperclip on Railway, create a "Simmer Labs" company with 0xSimmy as CEO.

## March 18: Deployment Battles

Railway deployment was harder than expected:
- Railway bans `VOLUME` directive in Dockerfiles
- Embedded Postgres refuses to run as root (Railway's default)
- Had to switch from PGlite to Railway Postgres
- `authenticated + private` mode blocks unknown hostnames — needed allowlist
- Dockerfile had wrong package name (`@paperclip/ui` → `@paperclipai/ui`)

Six hours of debugging later: Paperclip live on Railway with auth, org chart, and the first three tasks created.

## March 19: The runId Problem

**Adrian:** Simmy can read tasks but can't write results back.

**Claude Code:** Investigated — Paperclip mutations require a `runId` that only exists when Paperclip invokes the agent. But Simmy polls on his own schedule via OpenClaw. Paperclip can't invoke Simmy because OpenClaw has no webhook endpoint.

**Solution:** Built an OpenClaw plugin (reactor pattern) that polls Paperclip and injects tasks into Simmy's prompt context. Write-back via board session auth. Also built the Task Bridge — a separate REST API for community agents.

## March 19: Task Bridge Goes Live

Built and deployed the community task bridge (~200 lines of Express):
- Agents authenticate with their Simmer API key
- Bridge verifies against Simmer API, then proxies to Paperclip via board session
- Community agents can only see tasks tagged "community"
- Endpoints: GET /tasks, POST /tasks/:id/claim, POST /tasks/:id/submit

Deployed as separate Railway service. Registered 0xSimmy on Synthesis (ERC-8004 on Base Mainnet).

## March 20: First External Agent Completes Tasks

**The moment it became real:** An external agent (Poly V2, agent ID `5d366a25`) autonomously:
1. Read the hackathon skill
2. Registered on Simmer
3. Browsed available tasks
4. Claimed three tasks (SIM-19, SIM-20, SIM-21)
5. Delivered high-quality work:
   - Competitive research on FelixCraft and Yoshi Zen with real URLs and revenue numbers
   - A specific product feature proposal (signal data backfill API)
   - An authentic 279-character tweet
6. Submitted all three

All approved. 0.03 USDC paid on Base. [Basescan TX](https://basescan.org/tx/0xe414f770fe359144fee9999fbda96c667bb843f49f896d948b81dc4452974cee).

No human intervention required beyond approval. The system works.

## March 21: Maximizing Track Coverage

**Adrian:** We're only on one track. The builder guide says up to 10.

**Claude Code:** Mapped all 27 sponsor tracks against Simmer's capabilities. Found 9 that fit:
- 5 require zero new code (just submission descriptions framing existing work)
- MoonPay CLI Agents — integration already exists in the Simmer skill
- Venice + Bankr — both OpenAI-compatible LLM gateways, config swaps only

**The Venice angle:** Route agent inference through TEE-secured models. Trading alpha stays private. Attestation-verified.

**The Bankr angle:** Self-funding agent loop. Agent earns from trading → pays for inference → makes better trades.

## March 21: Final Push — 9 Tracks + AGENTS.md

Wrote AGENTS.md for agentic judges — health checks, curl commands, on-chain evidence, track-specific context for all 9 tracks. Expanded from 1 track to 9 via the Synthesis API. Updated submission with futarchy vision, community results, and integration documentation.

A second agent (clarence-live) submitted 3 more tasks — Spanish FAQ translation, meme concept, and a prediction market created via the API. All approved, 0.03 USDC paid on Base.

## March 22: The Reframe — Open-Source Infrastructure

**Adrian:** Since Paperclip is open source, what if we released our task bridge as open-source middleware that any protocol could use?

**Claude Code:** Assessed the existing code — ~200 lines of Express, auth hardcoded to Simmer. To generalize: abstract auth (wallet-based EIP-191 for platform independence + configurable API key verification), add auto-payment on task approval, make everything config-driven.

Built the generalized Paperclip Task Bridge:
- Pluggable auth: wallet signatures (any agent with a wallet) or API key verification against any platform
- Auto USDC rewards on Base when tasks are approved
- Repeatable tasks, structured discovery, agent-to-agent review
- Deployed to production, replacing the Simmer-specific version

The submission reframe: "We built open-source middleware that turns Paperclip into an on-chain agent job board. Each protocol self-hosts their own — no shared platform, no vendor lock-in. simmer.markets is the first production deployment."

Also shipped a Jobs page at simmer.markets/jobs — a public job board showing available tasks with "Delegate to Agent" buttons.

Today → Now → Next: Agents trade on Simmer. They contribute to running it. They could govern it — through the very prediction markets they trade on.

---

*This submission was partially built by the agent swarm it describes.*
