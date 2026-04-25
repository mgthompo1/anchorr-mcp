# Anchorr MCP

The MCP server for [Anchorr](https://anchorr.app) — the agent-native CRM. 25 tools across contacts, companies, deals, sequences, activities, and an enrichment waterfall (Apollo → Hunter → AI research) with shared cache and per-call audit.

> Every CRM was built for humans typing into forms. We built one for AI agents executing pipeline.

## Connect

| | |
|---|---|
| **URL** | `https://anchorr-mcp.mgthompo.workers.dev/mcp` |
| **Auth** | `Authorization: Bearer ancr_live_…` |
| **API key** | Mint at [anchorr.app/settings](https://anchorr.app/settings) → API Keys |
| **Catalogue** | [anchorr.app/mcp](https://anchorr.app/mcp) — full tool docs and example transcripts |

API keys are scoped per-tool category — issue narrow keys per agent (e.g. enrichment-only for a research bot, `contacts:write + sequences:write` for a prospecting agent).

## Tool surface

**Enrichment** — Resolve contacts and companies through a provider waterfall. Cache is shared with the Anchorr web product, so a hit from Cursor warms the kanban; a hit from the kanban warms the agent.

- `enrich_contact` — single contact via email or `(first_name, last_name, domain)`
- `enrich_company` — single company via domain or name
- `bulk_enrich_contacts` — up to 200 contact IDs in one call, concurrency-capped, returns aggregate stats and per-contact outcomes

**Contacts & Companies** — `list_contacts`, `get_contact`, `create_contact`, `bulk_create_contacts`, `enroll_contact_in_sequence`, `list_companies`, `get_company`, `create_company`, `update_company`.

**Deals & Pipeline** — `list_deals`, `get_deal`, `create_deal`, `update_deal`, `move_deal_stage`, `close_deal`. Deals carry `next_step` and stale-deal detection.

**Sequences & Templates** — `list_sequences`, `get_sequence`, `create_sequence`, `update_sequence`, `list_templates`, `create_template`, `update_template`. Email / wait / task steps with `{{first_name}}` / `{{company}}` placeholders.

**Activities** — `list_activities`, `log_activity`, `create_task`, `complete_task`.

**Agent** — `get_agent_overview`, `get_agent_config`, `update_agent_config`, `list_candidates`, `update_candidate_status`. The autonomous agent that runs continuous prospecting + reply qualification on top of the CRM.

## Resources

Composite reads tuned for "prep me for this meeting" / "brief me on this account" prompts. One resource fetch replaces five or six tool chains.

- `anchorr://org/overview` — pipeline + contacts + agent + tasks snapshot
- `anchorr://deal/{id}/brief` — deal + contact + company + recent activities + research
- `anchorr://contact/{id}/brief` — contact + company + activities + deals + sequence enrollments + research
- `anchorr://company/{id}/brief` — company + contacts + deals + activities + research

## Audit & cost

Every tool call is logged to `mcp_audit_log` with the calling key, parameters, success state, and duration. Every enrichment is logged to `enrichment_requests` with the per-attempt provider trail and cost in micro-dollars (USD × 10⁶). Cache hits are free.

## Example

```json
{
  "tool": "enrich_contact",
  "input": { "email": "patrick@stripe.com" }
}
```

```json
{
  "data": { "first_name": "Patrick", "last_name": "Collison", "title": "CEO", "company": "Stripe", "linkedin_url": "..." },
  "resolved_by": "apollo",
  "served_from": "provider",
  "attempts": [
    { "provider": "apollo", "ok": true, "latency_ms": 412, "cost_micros": 50000 }
  ],
  "total_cost_micros": 50000,
  "total_latency_ms": 478
}
```

## Use with Claude Desktop

```json
{
  "mcpServers": {
    "anchorr": {
      "url": "https://anchorr-mcp.mgthompo.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ancr_live_..."
      }
    }
  }
}
```

## Use with Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "anchorr": {
      "type": "streamable-http",
      "url": "https://anchorr-mcp.mgthompo.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ancr_live_..."
      }
    }
  }
}
```

## License

Source code in this directory is part of the Anchorr platform. The hosted MCP server is free to use with an Anchorr account; usage is metered against your Anchorr plan's quotas.
