//! Tools that manage the run itself: the plan, findings, questions to the user,
//! finishing, and showing images.

use super::{Ctx, Output, files, list_arg, num_arg, str_arg};
use crate::store::{Finding, Plan, PlanStep};
use serde_json::Value;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// The plan as the model and the user both read it.
pub fn format_plan(plan: &Plan) -> String {
    let mut out = format!("PLAN. Goal: {}\n", plan.goal);
    for s in &plan.steps {
        let mark = match s.state.as_str() {
            "done" => "[x]",
            "doing" => "[>]",
            "blocked" => "[!]",
            _ => "[ ]",
        };
        out.push_str(&format!("{mark} {}. {}", s.id, s.text));
        if !s.note.is_empty() {
            out.push_str(&format!(" ({})", s.note));
        }
        out.push('\n');
    }
    out
}

fn publish(ctx: &Ctx) {
    ctx.emit.state(ctx.chat.lock().unwrap().clone());
}

pub fn make_plan(ctx: &Ctx, args: &Value) -> Output {
    let goal = str_arg(args, "goal").trim();
    let steps = list_arg(args, "steps");
    if goal.is_empty() || steps.is_empty() {
        return Output::fail("make_plan needs a goal and a list of steps (each its own string).");
    }
    let mut chat = ctx.chat.lock().unwrap();
    // Finished steps carry over when the plan is replaced mid-run.
    let done: Vec<PlanStep> = chat.plan.take().map(|p| p.steps.into_iter().filter(|s| s.state == "done").collect()).unwrap_or_default();
    let steps = steps
        .iter()
        .enumerate()
        .map(|(i, text)| match done.iter().find(|d| d.text.trim() == text.trim()) {
            Some(d) => PlanStep { id: i as u32 + 1, ..d.clone() },
            None => PlanStep { id: i as u32 + 1, text: text.trim().to_string(), state: "todo".into(), note: String::new() },
        })
        .collect();
    let plan = Plan { goal: goal.to_string(), steps };
    let text = format!("{}\nWork it step by step. Mark progress with update_plan in the same turn as your next real tool call.", format_plan(&plan));
    let summary = format!("Plan: {} steps", plan.steps.len());
    chat.plan = Some(plan);
    chat.finish_bounced = false;
    drop(chat);
    publish(ctx);
    Output::ok(text, summary)
}

pub fn update_plan(ctx: &Ctx, args: &Value) -> Output {
    let Some(updates) = args["updates"].as_array() else { return Output::fail("updates must be a list of {id, state}.") };
    let mut chat = ctx.chat.lock().unwrap();
    let Some(plan) = chat.plan.as_mut() else { return Output::fail("There is no plan yet. Call make_plan first.") };
    let mut problems = Vec::new();
    for u in updates {
        let state = str_arg(u, "state");
        let Some(step) = num_arg(u, "id").and_then(|id| plan.steps.iter_mut().find(|s| s.id as u64 == id)) else {
            problems.push(format!("No step {}.", u["id"]));
            continue;
        };
        match state {
            "done" if str_arg(u, "verified").trim().is_empty() => {
                problems.push(format!("Step {} is not done until you say how you checked it (verified).", step.id));
            }
            "blocked" if str_arg(u, "blocker").trim().is_empty() => {
                problems.push(format!("Step {} needs a blocker: what outside your control is in the way.", step.id));
            }
            "todo" | "doing" | "done" | "blocked" => {
                step.state = state.to_string();
                step.note = str_arg(u, if state == "done" { "verified" } else { "blocker" }).trim().to_string();
            }
            other => problems.push(format!("Unknown state `{other}` for step {}.", step.id)),
        }
    }
    let done = plan.steps.iter().filter(|s| s.state == "done").count();
    let text = format!("{}{}", format_plan(plan), problems.join("\n"));
    let summary = format!("Plan: {done}/{} done", plan.steps.len());
    drop(chat);
    publish(ctx);
    Output { ok: problems.is_empty(), ..Output::ok(text, summary) }
}

/// Active findings, listed to the model every turn so it never re-derives them.
pub fn format_findings(findings: &[Finding]) -> String {
    let active: Vec<&Finding> = findings.iter().filter(|f| f.active).collect();
    if active.is_empty() {
        return String::new();
    }
    let mut out = String::from("FINDINGS you recorded earlier in this chat (your working memory; use the relevant ones, do not cite them):\n");
    for f in active {
        out.push_str(&format!("[{}] {}", f.id, f.claim));
        if !f.evidence.is_empty() {
            out.push_str(&format!(" (evidence: {})", f.evidence));
        }
        if !f.refs.is_empty() {
            out.push_str(&format!(" [{}]", f.refs.join(", ")));
        }
        out.push('\n');
    }
    out
}

pub fn note_finding(ctx: &Ctx, args: &Value) -> Output {
    // Oversized text is sliced, never shipped whole.
    let short = |s: &str, n: usize| s.trim().chars().take(n).collect::<String>();
    let claim = short(str_arg(args, "claim"), 400);
    if claim.is_empty() {
        return Output::fail("claim is required: the conclusion in one sentence.");
    }
    let mut chat = ctx.chat.lock().unwrap();
    let id = str_arg(args, "id").trim().trim_matches(['[', ']']).to_string();
    let text = if !id.is_empty() && str_arg(args, "status") == "disproved" {
        match chat.findings.iter_mut().find(|f| f.id == id) {
            Some(f) => {
                f.active = false;
                format!("Retired finding [{id}]: {claim}")
            }
            None => return Output::fail(format!("No finding [{id}].")),
        }
    } else {
        let id = format!("f{}", chat.findings.len() + 1);
        chat.findings.push(Finding { id: id.clone(), claim: claim.clone(), evidence: short(str_arg(args, "evidence"), 300), refs: list_arg(args, "refs"), active: true });
        format!("Recorded finding [{id}].")
    };
    drop(chat);
    publish(ctx);
    Output::ok(text, format!("Noted: {}", claim.chars().take(80).collect::<String>()))
}

pub fn finish(ctx: &Ctx, args: &Value) -> Output {
    let result = str_arg(args, "result").trim();
    if result.is_empty() || str_arg(args, "verified").trim().is_empty() {
        return Output::fail("finish needs result (what was done) and verified (how each claim was checked).");
    }
    let mut chat = ctx.chat.lock().unwrap();
    let open: Vec<String> = chat.plan.iter().flat_map(|p| &p.steps).filter(|s| s.state != "done").map(|s| format!("{}. {} [{}]", s.id, s.text, s.state)).collect();
    if !open.is_empty() && !chat.finish_bounced {
        chat.finish_bounced = true;
        return Output::fail(format!("The plan still has open steps:\n{}\nFinish them, or call finish again to end anyway and say plainly what was not done.", open.join("\n")));
    }
    Output { finish: true, ..Output::ok("Run finished.", "Finished") }
}

pub async fn ask_user(ctx: &Ctx, args: &Value) -> Output {
    let question = str_arg(args, "question").trim();
    if question.is_empty() {
        return Output::fail("question is required.");
    }
    let options: Vec<String> = list_arg(args, "options").into_iter().take(4).collect();
    match ctx.emit.question(question, options, str_arg(args, "context")).await {
        Some(answer) if !answer.trim().is_empty() => Output::ok(format!("The user answered: {answer}"), format!("Answer: {}", answer.chars().take(80).collect::<String>())),
        _ => Output::fail("The user skipped the question. Use your best judgement and say which default you chose."),
    }
}

fn image_path(ctx: &Ctx, args: &Value) -> Result<std::path::PathBuf, String> {
    let rel = str_arg(args, "path");
    let path = files::resolve(&ctx.root, rel)?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("{rel} is not an image this app can show (png, jpg, webp, gif, bmp)."));
    }
    if !path.is_file() {
        return Err(format!("{rel} does not exist in the workspace."));
    }
    Ok(path)
}

pub fn show_image(ctx: &Ctx, args: &Value) -> Output {
    match image_path(ctx, args) {
        Ok(path) => {
            let caption = str_arg(args, "caption");
            let summary = if caption.is_empty() { format!("Showed {}", str_arg(args, "path")) } else { caption.to_string() };
            Output { image: Some(path), ..Output::ok("The image is now shown to the user in the chat.", summary) }
        }
        Err(e) => Output::fail(e),
    }
}

pub fn view_image(ctx: &Ctx, args: &Value) -> Output {
    match image_path(ctx, args) {
        Ok(path) => {
            let question = str_arg(args, "question");
            let text = format!("The image {} is attached to the next message. {}", str_arg(args, "path"), if question.is_empty() { "Look at it." } else { question });
            Output { look: Some(path.clone()), image: Some(path), ..Output::ok(text, format!("Looked at {}", str_arg(args, "path"))) }
        }
        Err(e) => Output::fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_and_findings_render() {
        let plan = Plan {
            goal: "ship".into(),
            steps: vec![
                PlanStep { id: 1, text: "write".into(), state: "done".into(), note: "ran it".into() },
                PlanStep { id: 2, text: "test".into(), state: "todo".into(), note: String::new() },
            ],
        };
        let text = format_plan(&plan);
        assert!(text.contains("[x] 1. write (ran it)") && text.contains("[ ] 2. test"));
        assert_eq!(format_findings(&[]), "");
        let f = [Finding { id: "f1".into(), claim: "c".into(), evidence: "e".into(), refs: vec![], active: true }, Finding { id: "f2".into(), claim: "old".into(), active: false, ..Default::default() }];
        let text = format_findings(&f);
        assert!(text.contains("[f1] c (evidence: e)") && !text.contains("old"));
    }
}
