import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askNow from "./index.ts";

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	executionMode?: string;
	promptGuidelines?: string[];
	parameters: {
		additionalProperties?: unknown;
		required?: string[];
		properties?: Record<string, Record<string, unknown>>;
	};
	execute: (...args: any[]) => Promise<any>;
	renderCall: (...args: any[]) => any;
	renderResult: (...args: any[]) => any;
}

function registerTool(): RegisteredTool {
	const tools: RegisteredTool[] = [];
	askNow({ registerTool: (tool: RegisteredTool) => tools.push(tool) } as unknown as ExtensionAPI);
	assert.equal(tools.length, 1);
	return tools[0];
}

function context(
	ui: {
		input?: (title: string, placeholder?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
		select?: (title: string, options: string[], dialogOptions?: { signal?: AbortSignal }) => Promise<string | undefined>;
	} = {},
	hasUI = true,
) {
	return {
		hasUI,
		ui: {
			input: ui.input ?? (async () => undefined),
			select: ui.select ?? (async () => undefined),
		},
	};
}

async function execute(
	tool: RegisteredTool,
	params: { question: string; options?: string[] },
	ctx: ReturnType<typeof context>,
	signal: AbortSignal = new AbortController().signal,
) {
	return tool.execute("call-1", params, signal, undefined, ctx);
}

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
};

function rendered(component: { render: (width: number) => string[] }) {
	return component
		.render(500)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("ask-now extension", () => {
	test("registers one strict sequential tool with self-contained prompt metadata", () => {
		const tool = registerTool();
		assert.equal(tool.name, "ask_now");
		assert.equal(tool.executionMode, "sequential");
		assert.match(tool.description, /Ask the user one question/);
		assert.match(tool.promptSnippet ?? "", /one blocking clarification/);
		assert.ok(tool.promptGuidelines?.every((guideline) => guideline.includes("ask_now")));
		assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes("secrets")));

		assert.equal(tool.parameters.additionalProperties, false);
		assert.deepEqual(tool.parameters.required, ["question"]);
		assert.equal(tool.parameters.properties?.question?.minLength, 1);
		assert.equal(tool.parameters.properties?.question?.maxLength, 500);
		assert.equal(tool.parameters.properties?.options?.minItems, 2);
		assert.equal(tool.parameters.properties?.options?.maxItems, 5);
	});

	test("asks for free text, forwards the signal, trims the answer, and returns text details", async () => {
		const tool = registerTool();
		const controller = new AbortController();
		let call: any;
		const result = await execute(
			tool,
			{ question: "  Which database?  " },
			context({
				input: async (title, placeholder, options) => {
					call = { title, placeholder, options };
					return "  SQLite  ";
				},
			}),
			controller.signal,
		);

		assert.deepEqual(call, {
			title: "Which database?",
			placeholder: "Type your answer",
			options: { signal: controller.signal },
		});
		assert.equal(result.content[0].text, "User answered: SQLite");
		assert.deepEqual(result.details, {
			status: "answered",
			question: "Which database?",
			mode: "text",
			options: [],
			answer: { kind: "text", text: "SQLite" },
		});
	});

	test("shows numbered choices plus Other and maps a listed choice to its label and index", async () => {
		const tool = registerTool();
		const controller = new AbortController();
		let call: any;
		const result = await execute(
			tool,
			{ question: "Database?", options: ["PostgreSQL (Recommended)", "SQLite"] },
			context({
				select: async (title, options, dialogOptions) => {
					call = { title, options, dialogOptions };
					return options[0];
				},
			}),
			controller.signal,
		);

		assert.deepEqual(call, {
			title: "Database?",
			options: ["1. PostgreSQL (Recommended)", "2. SQLite", "Other (type an answer)"],
			dialogOptions: { signal: controller.signal },
		});
		assert.equal(result.content[0].text, "User selected option 1: PostgreSQL (Recommended)");
		assert.deepEqual(result.details.answer, {
			kind: "choice",
			text: "PostgreSQL (Recommended)",
			optionIndex: 1,
		});
	});

	test("asks for custom text after Other and forwards the same signal", async () => {
		const tool = registerTool();
		const controller = new AbortController();
		let inputCall: any;
		const result = await execute(
			tool,
			{ question: "Database?", options: ["PostgreSQL", "SQLite"] },
			context({
				select: async (_title, options) => options[2],
				input: async (title, placeholder, options) => {
					inputCall = { title, placeholder, options };
					return "  DuckDB  ";
				},
			}),
			controller.signal,
		);

		assert.deepEqual(inputCall, {
			title: "Your answer",
			placeholder: "Type a custom answer",
			options: { signal: controller.signal },
		});
		assert.equal(result.content[0].text, "User answered: DuckDB");
		assert.deepEqual(result.details.answer, { kind: "text", text: "DuckDB" });
	});

	test("classifies cancellation from free text, selection, and Other input", async () => {
		const tool = registerTool();
		const fromText = await execute(tool, { question: "Database?" }, context({ input: async () => undefined }));
		const fromSelect = await execute(
			tool,
			{ question: "Database?", options: ["PostgreSQL", "SQLite"] },
			context({ select: async () => undefined }),
		);
		const fromOtherInput = await execute(
			tool,
			{ question: "Database?", options: ["PostgreSQL", "SQLite"] },
			context({ select: async (_title, options) => options[2], input: async () => undefined }),
		);

		for (const result of [fromText, fromSelect, fromOtherInput]) {
			assert.equal(result.details.status, "cancelled");
			assert.equal(result.details.answer, null);
			assert.equal(result.content[0].text, "User did not answer the question. Do not assume an answer.");
		}
	});

	test("treats blank text and oversized text as no answer", async () => {
		const tool = registerTool();
		const blank = await execute(tool, { question: "Database?" }, context({ input: async () => "  \t " }));
		assert.equal(blank.details.status, "cancelled");
		assert.equal(blank.details.answer, null);

		const oversized = await execute(
			tool,
			{ question: "Database?" },
			context({ input: async () => "😀".repeat(4097) }),
		);
		assert.equal(oversized.details.status, "cancelled");
		assert.equal(oversized.details.answer, null);
		assert.match(oversized.content[0].text, /exceeded 16 KiB and was not accepted/);
		assert.ok(!oversized.content[0].text.includes("😀"));
	});

	test("does not open a dialog when the signal is already aborted", async () => {
		const tool = registerTool();
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const result = await execute(
			tool,
			{ question: "Database?" },
			context({ input: async () => ((called = true), "ignored") }),
			controller.signal,
		);

		assert.equal(called, false);
		assert.equal(result.details.status, "cancelled");
		assert.equal(
			result.content[0].text,
			"The question was cancelled because the agent turn was aborted. Do not assume an answer.",
		);
	});

	test("distinguishes an abort while a dialog is active from user cancellation", async () => {
		const tool = registerTool();
		const controller = new AbortController();
		const result = await execute(
			tool,
			{ question: "Database?" },
			context({
				input: async () => {
					controller.abort();
					return undefined;
				},
			}),
			controller.signal,
		);

		assert.equal(result.details.status, "cancelled");
		assert.match(result.content[0].text, /agent turn was aborted/);
	});

	test("returns unavailable without accessing UI methods when there is no UI", async () => {
		const tool = registerTool();
		let called = false;
		const result = await execute(
			tool,
			{ question: "Database?" },
			context(
				{
					input: async () => ((called = true), "ignored"),
					select: async () => ((called = true), "ignored"),
				},
				false,
			),
		);

		assert.equal(called, false);
		assert.equal(result.details.status, "unavailable");
		assert.equal(result.details.answer, null);
		assert.equal(
			result.content[0].text,
			"Interactive UI is unavailable. Ask the question in a normal assistant response instead.",
		);
	});

	test("normalizes whitespace and rejects blank or duplicate choices", async () => {
		const tool = registerTool();
		let shownOptions: string[] = [];
		const result = await execute(
			tool,
			{ question: "  Pick one  ", options: ["  First  ", " Second "] },
			context({
				select: async (_title, options) => {
					shownOptions = options;
					return options[1];
				},
			}),
		);

		assert.deepEqual(shownOptions, ["1. First", "2. Second", "Other (type an answer)"]);
		assert.equal(result.details.question, "Pick one");
		assert.deepEqual(result.details.options, ["First", "Second"]);
		await assert.rejects(execute(tool, { question: "Pick", options: ["First", "   "] }, context()), /must not be blank/);
		await assert.rejects(
			execute(tool, { question: "Pick", options: ["First", " first "] }, context()),
			/must be unique/,
		);
	});

	test("keeps a literal Other sentinel distinct from the custom-answer entry", async () => {
		const tool = registerTool();
		const result = await execute(
			tool,
			{ question: "Pick", options: ["Other (type an answer)", "None"] },
			context({ select: async (_title, options) => options[0] }),
		);

		assert.deepEqual(result.details.answer, {
			kind: "choice",
			text: "Other (type an answer)",
			optionIndex: 1,
		});
	});

	test("renders compact calls and tolerates incomplete renderer data", () => {
		const tool = registerTool();
		const collapsed = rendered(tool.renderCall({ question: "Database?", options: ["PostgreSQL"] }, theme, { expanded: false }));
		const expanded = rendered(
			tool.renderCall({ question: "Database?", options: ["PostgreSQL", undefined] }, theme, { expanded: true }),
		);
		assert.equal(collapsed, "ask_now Database?");
		assert.match(expanded, /1\. PostgreSQL/);
		assert.equal(rendered(tool.renderResult({ details: undefined }, {}, theme, {})), "");
		assert.equal(rendered(tool.renderResult({ details: { status: "answered" } }, {}, theme, {})), "No answer");
	});

	test("renders distinct answered, cancelled, unavailable, and oversized summaries", () => {
		const tool = registerTool();
		const choice = rendered(
			tool.renderResult(
				{ details: { status: "answered", answer: { kind: "choice", text: "PostgreSQL", optionIndex: 1 } } },
				{},
				theme,
				{},
			),
		);
		const text = rendered(
			tool.renderResult(
				{ details: { status: "answered", answer: { kind: "text", text: "DuckDB" } } },
				{},
				theme,
				{},
			),
		);
		const cancelled = rendered(tool.renderResult({ details: { status: "cancelled", answer: null } }, {}, theme, {}));
		const unavailable = rendered(
			tool.renderResult({ details: { status: "unavailable", answer: null } }, {}, theme, {}),
		);
		const tooLong = rendered(
			tool.renderResult(
				{
					details: {
						status: "cancelled",
						answer: null,
						message:
							"The user's answer exceeded 16 KiB and was not accepted. Ask the question again and request a shorter answer.",
					},
				},
				{},
				theme,
				{},
			),
		);

		assert.equal(choice, "✓ 1. PostgreSQL");
		assert.equal(text, "✓ (wrote) DuckDB");
		assert.equal(cancelled, "No answer");
		assert.equal(unavailable, "Interactive UI unavailable");
		assert.equal(tooLong, "Answer too long");
	});
});
