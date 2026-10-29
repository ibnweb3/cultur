// Admin-only measurement: does a coding model that gets a QlooVibe brief ship fewer generic-template markers
// than one that gets only the project text? Both pages are written by the same model with the same settings
// and checked by the same deterministic audit. It measures adherence and marker rates, not design quality.
import { auditUi, type AuditResult } from "./audit";

type Ai = { run: (model: never, input: never) => Promise<unknown> };

const SYSTEM = "You are a front-end developer. Reply with ONE complete HTML file (inline <style>, no external assets or scripts) and nothing else. No explanations.";

function extractCode(resp: unknown): string {
  const r = resp as { response?: unknown; choices?: { message?: { content?: string } }[] };
  const raw = String(r?.response ?? r?.choices?.[0]?.message?.content ?? "");
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1]! : raw).trim();
}

export interface BenchArm { code_chars: number; audit: Pick<AuditResult, "status" | "summary" | "metrics" | "checks"> & { finding_ids: string[] }; code: string }
export interface BenchRow { project: string; direction: string; baseline: BenchArm; briefed: BenchArm; repaired: BenchArm & { rounds: number } }

export async function buildBenchRow(ai: Ai, model: string, project: string, brief: { name: string; agent_brief: string }): Promise<BenchRow> {
  const generate = async (user: string): Promise<string> => extractCode(await ai.run(model as never, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], temperature: 0, max_tokens: 2600 } as never));
  const baseCode = await generate(`Build the home page for this project. Make it distinctive and specific to its audience, not a generic template.\n\nProject: ${project}`);
  const briefCode = await generate(`Build the home page for this project. Follow the design brief below exactly.\n\nProject: ${project}\n\nDESIGN BRIEF:\n${brief.agent_brief}`);
  const arm = (code: string): BenchArm => {
    const a = auditUi(code, brief.agent_brief);
    return { code_chars: code.length, code, audit: { status: a.status, summary: a.summary, metrics: a.metrics, checks: a.checks, finding_ids: a.findings.map((f) => f.id) } };
  };
  const first = auditUi(briefCode, brief.agent_brief);
  let fixedCode = briefCode, rounds = 0;
  if (first.status !== "pass") {
    // One audit-and-fix round: the model sees only the audit's own findings, the way an agent calling audit_ui would.
    const problems = first.findings.map((f) => `- ${f.message} ${f.examples.length ? "Examples: " + f.examples.join(", ") + ". " : ""}Fix: ${f.fix}`).join("\n");
    fixedCode = await generate(`Here is an HTML page you wrote.

${briefCode}

An automatic audit against the design brief found these problems:
${problems}

Return the complete corrected HTML file.

DESIGN BRIEF:
${brief.agent_brief}`);
    rounds = 1;
  }
  return { project, direction: brief.name, baseline: arm(baseCode), briefed: arm(briefCode), repaired: { ...arm(fixedCode), rounds } };
}
