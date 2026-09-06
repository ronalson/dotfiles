import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Buffer } from "node:buffer";
import { Type, type Static } from "typebox";

const OTHER_OPTION = "Other (type an answer)";
const MAX_ANSWER_BYTES = 16 * 1024;
const ANSWER_TOO_LONG_MESSAGE =
	"The user's answer exceeded 16 KiB and was not accepted. Ask the question again and request a shorter answer.";

const AskNowParamsSchema = Type.Object(
	{
		question: Type.String({
			description: "One direct question, including any context the user needs",
			minLength: 1,
			maxLength: 500,
		}),
		options: Type.Optional(
			Type.Array(
				Type.String({ minLength: 1, maxLength: 120 }),
				{
					description: "Two to five mutually exclusive choice labels; omit for free text",
					minItems: 2,
					maxItems: 5,
				},
			),
		),
	},
	{ additionalProperties: false },
);

export type AskNowParams = Static<typeof AskNowParamsSchema>;

type AskNowStatus = "answered" | "cancelled" | "unavailable";
type AskNowMode = "text" | "choice";

type AskNowAnswer = {
	kind: "text" | "choice";
	text: string;
	optionIndex?: number;
};

interface AskNowDetails {
	status: AskNowStatus;
	question: string;
	mode: AskNowMode;
	options: string[];
	answer: AskNowAnswer | null;
	message?: string;
}

interface NormalizedParams {
	question: string;
	mode: AskNowMode;
	options: string[];
}

function normalizeParams(params: AskNowParams): NormalizedParams {
	const question = params.question.trim();
	if (question.length === 0) throw new Error("ask_now question must not be blank");
	if (question.length > 500) throw new Error("ask_now question must be at most 500 characters");

	if (params.options === undefined) {
		return { question, mode: "text", options: [] };
	}
	if (params.options.length < 2 || params.options.length > 5) {
		throw new Error("ask_now options must contain between 2 and 5 choices");
	}

	const options = params.options.map((option, index) => {
		const normalized = option.trim();
		if (normalized.length === 0) throw new Error(`ask_now option ${index + 1} must not be blank`);
		if (normalized.length > 120) throw new Error(`ask_now option ${index + 1} must be at most 120 characters`);
		return normalized;
	});

	const seen = new Set<string>();
	for (const option of options) {
		const key = option.toLowerCase();
		if (seen.has(key)) throw new Error(`ask_now options must be unique (duplicate: ${option})`);
		seen.add(key);
	}

	return { question, mode: "choice", options };
}

function toolResult(details: AskNowDetails, text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function answeredResult(params: NormalizedParams, answer: AskNowAnswer, text: string) {
	return toolResult(
		{
			status: "answered",
			question: params.question,
			mode: params.mode,
			options: params.options,
			answer,
		},
		text,
	);
}

function cancelledResult(params: NormalizedParams, aborted: boolean) {
	const message = aborted
		? "The question was cancelled because the agent turn was aborted. Do not assume an answer."
		: "User did not answer the question. Do not assume an answer.";
	return toolResult(
		{
			status: "cancelled",
			question: params.question,
			mode: params.mode,
			options: params.options,
			answer: null,
			message,
		},
		message,
	);
}

function answerTooLongResult(params: NormalizedParams) {
	return toolResult(
		{
			status: "cancelled",
			question: params.question,
			mode: params.mode,
			options: params.options,
			answer: null,
			message: ANSWER_TOO_LONG_MESSAGE,
		},
		ANSWER_TOO_LONG_MESSAGE,
	);
}

function textAnswerResult(params: NormalizedParams, value: string, aborted: boolean) {
	const answer = value.trim();
	if (answer.length === 0) return cancelledResult(params, aborted);
	if (Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES) return answerTooLongResult(params);
	return answeredResult(params, { kind: "text", text: answer }, `User answered: ${answer}`);
}

function unavailableResult(params: NormalizedParams) {
	const message = "Interactive UI is unavailable. Ask the question in a normal assistant response instead.";
	return toolResult(
		{
			status: "unavailable",
			question: params.question,
			mode: params.mode,
			options: params.options,
			answer: null,
			message,
		},
		message,
	);
}

export default function askNow(pi: ExtensionAPI) {
	pi.registerTool<typeof AskNowParamsSchema, AskNowDetails>({
		name: "ask_now",
		label: "Ask Now",
		description:
			"Ask the user one question through the interactive UI and wait for their answer. Use when missing information or a user preference materially changes what to do next.",
		promptSnippet: "Ask the user one blocking clarification or decision question through the UI",
		promptGuidelines: [
			"Use ask_now when a missing requirement, preference, or approval materially changes the next action.",
			"Use ask_now instead of guessing between meaningfully different valid paths.",
			"Ask exactly one concise question in each ask_now call.",
			"Never emit multiple ask_now calls in the same assistant message; wait for one answer before deciding whether another question is needed.",
			"Call ask_now before any action that depends on the answer, and do not batch it with dependent mutating tools.",
			"When using ask_now options, provide two to five mutually exclusive choices; put the recommended choice first and suffix its label with (Recommended).",
			"Do not use ask_now for facts that can be discovered with available tools, routine progress updates, or confirmation of an instruction the user already made explicit.",
			"Never use ask_now to request credentials or secrets.",
		],
		parameters: AskNowParamsSchema,
		executionMode: "sequential",

		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = normalizeParams(rawParams);
			if (signal?.aborted) return cancelledResult(params, true);
			if (!ctx.hasUI) return unavailableResult(params);

			if (params.mode === "text") {
				const value = await ctx.ui.input(params.question, "Type your answer", { signal });
				if (value === undefined) return cancelledResult(params, signal?.aborted === true);

				return textAnswerResult(params, value, signal?.aborted === true);
			}

			const numberedOptions = params.options.map((option, index) => `${index + 1}. ${option}`);
			const displayOptions = [...numberedOptions, OTHER_OPTION];
			const selected = await ctx.ui.select(params.question, displayOptions, { signal });
			if (selected === undefined) return cancelledResult(params, signal?.aborted === true);

			const selectedIndex = numberedOptions.indexOf(selected);
			if (selectedIndex >= 0) {
				const text = params.options[selectedIndex];
				return answeredResult(
					params,
					{ kind: "choice", text, optionIndex: selectedIndex + 1 },
					`User selected option ${selectedIndex + 1}: ${text}`,
				);
			}

			if (selected !== OTHER_OPTION) return cancelledResult(params, signal?.aborted === true);

			const value = await ctx.ui.input("Your answer", "Type a custom answer", { signal });
			if (value === undefined) return cancelledResult(params, signal?.aborted === true);

			return textAnswerResult(params, value, signal?.aborted === true);
		},

		renderCall(args, theme, context) {
			const question = typeof args.question === "string" ? args.question.trim() : "";
			let content = theme.fg("toolTitle", theme.bold("ask_now ")) + theme.fg("muted", question);

			if (context.expanded && Array.isArray(args.options)) {
				const options = args.options
					.filter((option): option is string => typeof option === "string")
					.map((option, index) => `${index + 1}. ${option.trim()}`)
					.join(", ");
				if (options.length > 0) content += `\n${theme.fg("dim", `  ${options}`)}`;
			}
			return new Text(content, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as Partial<AskNowDetails> | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "Interactive UI unavailable"), 0, 0);
			}
			if (details.message === ANSWER_TOO_LONG_MESSAGE) {
				return new Text(theme.fg("warning", "Answer too long"), 0, 0);
			}
			if (details.status === "cancelled" || !details.answer || typeof details.answer.text !== "string") {
				return new Text(theme.fg("warning", "No answer"), 0, 0);
			}
			if (details.answer.kind === "choice") {
				const prefix = Number.isInteger(details.answer.optionIndex) ? `${details.answer.optionIndex}. ` : "";
				return new Text(theme.fg("success", `✓ ${prefix}${details.answer.text}`), 0, 0);
			}
			return new Text(theme.fg("success", `✓ (wrote) ${details.answer.text}`), 0, 0);
		},
	});
}
