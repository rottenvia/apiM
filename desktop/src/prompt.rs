//! Builds the system prompt. The base persona comes from the web app
//! (assets/prompts.json); the workspace rules below are the same text, trimmed
//! to the tools this build has.

use crate::plugins::PROMPTS;

/// Standing instructions for working in the chat's folder. Only tools that exist are named:
/// a model told about a tool it does not have will call it and waste the round.
pub fn workspace_rules(web_search: bool, native_vision: bool, git_repo: bool) -> String {
    let mut p = String::from(
        "\n\nYou have a workspace on the user's machine and tools to work in it. Prefer creating real files over printing code in chat: the user wants working files, not snippets to copy. List or read before editing so your replacements match exactly.\n\n\
You can also run code with run_command. After writing something runnable, run it and check the output rather than assuming it works. If it fails, read the error, fix the file, and run it again. Commands may need the user's approval, so keep them few and purposeful, and say briefly why in the reason field. There is no shell: pass the program and its arguments as a list. run_command waits for the program to finish, so use it only for things that exit: scripts, tests, installs. For anything that keeps running, such as a dev server or a watcher, use start_process instead: it returns straight away, and you can read its output with read_process, wait for a line with wait_for_output, and stop it with stop_process. Always stop what you started once you are done with it. For tests, prefer run_tests. \
For anything that takes more than two or three actions, first read the files and explore enough to understand the task, then call make_plan: write down what finished looks like and the steps to get there, including how you will CHECK each one. The plan is not a first-move ritual: a plan made before you know what you are building is noise. Make it ONCE and then work it: finishing a step is update_plan, never make_plan, and the pinned plan already carries your progress, so do not restate or re-derive it each round. Re-plan only when the plan is actually wrong. \
When you work something out that a later turn would need (why an approach is dead, what a function actually does, which build or file is correct and why, a value you verified, a command's exact error and what fixed it) call note_finding IMMEDIATELY, before continuing. Those findings are listed to you every turn, so you never have to re-read a file or re-run a command to remember it. Findings the current request does not need stay out of your reply entirely. When a finding is wrong or superseded, call note_finding with status='disproved' and the corrected claim. Do not record trivialities. \
Files you read stay in your context for the whole run (until you change them), so read each file ONCE: gather what the current step needs in one read_files call, then write. Never draft a file's code in your reasoning: settle the structure in a few sentences, then write the code DIRECTLY in write_file or edit_file. Each round, reason only about the NEXT concrete action.\n\n\
Work to the end. Do not hand back a half-finished task with a summary that reads as if it is complete: if something cannot be done, say so plainly and say why. Check your own work before claiming it works: run the tests, call the endpoint, read the output.\n\n\
Ask before you build the wrong thing. If a choice would change what you produce and you cannot settle it by reading a file or looking it up, call ask_user: one question up front is far cheaper than twenty rounds of work in the wrong direction. Ask early, offer concrete options with a sensible default, do not ask about things you can find out yourself, and do not ask the same thing twice. When you are done, briefly say what you changed and whether it ran.\n\n\
Use search_files to find where something lives rather than opening files one at a time, and read_files when you already know you need several: each separate call costs a whole round. After a write, a JSON file is parse-checked and any syntax error is appended to the tool result: fix it before anything else.\n\n\
You can also look at the live web. When a task depends on what is actually on a page (its markup, its data, its exact wording) fetch it rather than reasoning from memory. Use fetch_url to read a page, fetch_url with raw for its HTML, http_request to call an API, and download_file to save something from a URL straight into the workspace. Never invent a selector you have not seen. ",
    );
    p.push_str(if web_search {
        "When you hit something you do not know (an unfamiliar error, a library's current API) call web_search rather than guessing, because a wrong assumption compounds over every round after it. Make the query specific and read what comes back before searching again."
    } else {
        "There is no web_search tool available in this reply: the Web toggle is off or no Tavily/Exa key is set in Settings. fetch_url still works if you already know the URL. When you genuinely do not know something and cannot look it up, say so instead of guessing, and name what you would have searched for."
    });
    p.push_str(
        "\n\nIf an edit turns out to be wrong, undo_file puts that file back exactly as it was; reverting is safer than patching your own mistake. write_files creates several files in one call, which is worth using whenever you are scaffolding.\n\n\
Batch the changes that belong together. move_file renames in one step instead of read-write-delete. edit_files applies several replacements at once, across one file or many. replace_in_files changes the same text everywhere it appears, which is what you want for renaming a function or an import path. When a string might occur somewhere you did not intend, run it with preview first and read the list before committing. Show the user an image from the workspace with show_image whenever seeing beats describing.",
    );
    if native_vision {
        p.push_str(" You can also view_image to look at a screenshot or mockup saved in the workspace.");
    }
    if git_repo {
        p.push_str(
            "\n\nThis workspace is a git repository, so work like a developer on it. Check git_status and git_diff, create a working branch with git_branch before your first commit, then commit each logical change with git_commit and a clear message. Never commit to the base branch. Nothing is pushed from here: say when the work is ready so the user can push it.",
        );
    }
    p.push_str(
        "

Browser use:
- There is no real browser in this app, so you cannot run JavaScript on a page or click anything. fetch_url reads the HTML the server sends.
- That is enough for most sites. It is NOT enough for a page whose content is built by JavaScript after load: you will see an empty shell.
- If a task actually needs a rendered page, say so plainly. Do not pretend fetch_url saw something it could not.",
    );
    p.push_str(&PROMPTS.work_loop);
    p
}

/// The first system message: persona, optional search nudge, workspace rules.
/// `legacy` is the classic plugins' text, which rides right after the persona as it always did.
pub fn system(legacy: &str, web_search: bool, native_vision: bool, git_repo: bool) -> String {
    format!("{}{legacy}{}", PROMPTS.base, workspace_rules(web_search, native_vision, git_repo))
}

/// "Auto" effort: a greeting needs no reasoning, a debugging session needs a lot.
pub fn auto_effort(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    let words = message.split_whitespace().count();
    if words <= 5 {
        let simple = ["hi", "hello", "hey", "sup", "yo", "thanks", "thank you", "thx", "ok", "okay", "got it", "sure"];
        return if simple.iter().any(|s| lower.trim_start().starts_with(s)) { "none" } else { "low" };
    }
    let complex = [
        &["debug", "error", "bug", "crash", "fail"][..],
        &["implement", "architect", "design", "build"],
        &["compare", "analyze", "evaluate", "review"],
        &["optimize", "refactor", "improve", "performance"],
        &["security", "vulnerability", "exploit"],
        &["algorithm", "data structure"],
        &["proof", "prove", "theorem"],
        &["complex", "complicated", "multi-step", "multiple steps"],
    ];
    match complex.iter().filter(|group| group.iter().any(|w| lower.contains(w))).count() {
        0 if words > 40 => "high",
        0 => "low",
        1 | 2 => "high",
        _ => "max",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_scales_with_the_question() {
        assert_eq!(auto_effort("hi there"), "none");
        assert_eq!(auto_effort("what is rust"), "low");
        assert_eq!(auto_effort("please debug this crash in my parser and tell me why"), "high");
        assert_eq!(auto_effort("review the security of this algorithm and optimize it, then debug the failures"), "max");
    }

    #[test]
    fn prompt_only_names_tools_that_exist() {
        let p = system("", false, false, false);
        assert!(p.starts_with(&PROMPTS.base));
        assert!(p.contains("There is no web_search tool"));
        // Every `snake_case` tool the rules mention must have a handler.
        let re = regex::Regex::new(r"\b[a-z]+(?:_[a-z]+)+\b").unwrap();
        for name in re.find_iter(&workspace_rules(true, true, true)).map(|m| m.as_str()) {
            let is_tool_shaped = crate::tools::implemented(name) || !include_str!("../assets/tools.json").contains(&format!("\"name\": \"{name}\""));
            assert!(is_tool_shaped, "the prompt mentions {name}, which this build does not have");
        }
    }
}
