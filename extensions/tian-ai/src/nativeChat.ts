/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import {
	runChatRequest,
	type AiChatEvent,
	type AiMessage,
	type AiProviderConfig,
	type AiToolRunner
} from '../../../packages/ai-agent-core/src/index';
import { getTianAiProviderConfigFromWorkspace } from './workspaceAiConfig';

export const TIAN_CHAT_PARTICIPANT_ID = 'tian-ai.workspace';
const MAX_ATTACHMENT_CHARS = 48_000;
const TIAN_VENDOR = 'tian';

export function registerWorkbenchNativeChat(
	context: vscode.ExtensionContext,
	toolRunner: AiToolRunner
): void {
	const onLmModelsChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push({ dispose: () => onLmModelsChanged.dispose() });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('tian-ai')) {
				onLmModelsChanged.fire();
			}
		})
	);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(TIAN_VENDOR, {
			onDidChangeLanguageModelChatInformation: onLmModelsChanged.event,
			provideLanguageModelChatInformation(): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
				const cfg = vscode.workspace.getConfiguration('tian-ai');
				const model = cfg.get<string>('model', 'gpt-4o-mini');
				const id = `tian/${model}`;
				return [
					{
						id,
						name: `${model} (Tian)`,
						family: 'tian',
						version: '1.0.0',
						maxInputTokens: 200000,
						maxOutputTokens: 8192,
						capabilities: { toolCalling: true }
					}
				];
			},
			async provideLanguageModelChatResponse(
				model: vscode.LanguageModelChatInformation,
				messages: readonly vscode.LanguageModelChatRequestMessage[],
				_options: vscode.ProvideLanguageModelChatResponseOptions,
				progress: vscode.Progress<vscode.LanguageModelResponsePart>,
				_token: vscode.CancellationToken
			): Promise<void> {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!root) {
					throw new Error('Open a folder workspace first.');
				}
				const aiMessages = vscodeLmRequestToAiMessages(messages);
				await streamTianRequest(root, aiConfigFromModel(model.id), aiMessages, toolRunner, delta =>
					progress.report(new vscode.LanguageModelTextPart(delta))
				);
			},
			async provideTokenCount(_model, text): Promise<number> {
				const s =
					typeof text === 'string'
						? text
						: stringifyLmParts([...(text as vscode.LanguageModelChatRequestMessage).content]);
				return Math.max(1, Math.ceil(s.length / 4));
			}
		})
	);

	const participant = vscode.chat.createChatParticipant(
		TIAN_CHAT_PARTICIPANT_ID,
		async (request, chatContext, response, token) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) {
				response.markdown('Open a folder workspace first.');
				return;
			}
			if (token.isCancellationRequested) {
				return;
			}
			const folders = vscode.workspace.workspaceFolders;
			const includeEditor = vscode.workspace.getConfiguration('tian-ai').get<boolean>('includeActiveEditor', true);
			const editor = vscode.window.activeTextEditor;
			const editorBlock =
				includeEditor && editor && editor.document.uri.scheme === 'file'
					? buildEditorBlock(editor, false)
					: '';
			const refBlock = referencesToBlock(request.references);
			const turnContent = [
				workspaceRootsExtra(folders),
				editorBlock,
				refBlock,
				request.prompt.trim()
			]
				.filter(Boolean)
				.join('\n\n');

			const historyMsgs = chatHistoryToAiMessages(chatContext.history);
			historyMsgs.push({ role: 'user', content: turnContent });

			try {
				await streamTianRequest(
					root,
					aiConfigFromWorkspace(),
					historyMsgs,
					toolRunner,
					delta => {
						response.markdown(delta);
					}
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				response.markdown(`**Error:** ${msg}`);
			}
		}
	);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'tian-ai.svg');
	context.subscriptions.push(participant);
}

function aiConfigFromWorkspace(): AiProviderConfig {
	return getTianAiProviderConfigFromWorkspace();
}

function aiConfigFromModel(modelId: string): AiProviderConfig {
	const base = aiConfigFromWorkspace();
	if (modelId.startsWith('tian/')) {
		base.model = modelId.slice('tian/'.length);
	}
	return base;
}

async function streamTianRequest(
	root: string,
	aiConfig: AiProviderConfig,
	messages: AiMessage[],
	toolRunner: AiToolRunner,
	onDelta: (delta: string) => void
): Promise<void> {
	const requestId = `tian-native-${Date.now()}`;
	const sendEvent = (event: AiChatEvent): void => {
		if (event.type === 'response-delta') {
			onDelta(event.delta);
			return;
		}
		if (event.type === 'response-error') {
			throw new Error(event.error);
		}
	};

	await runChatRequest({
		requestId,
		messageId: requestId,
		messages,
		config: aiConfig,
		executionContext: { currentFolder: root },
		sendEvent,
		toolRunner
	});
}

function workspaceRootsExtra(folders: readonly vscode.WorkspaceFolder[] | undefined): string {
	if (!folders?.length) { return ''; }
	if (folders.length === 1) { return `[workspace root]\n${folders[0].uri.fsPath}`; }
	const lines = folders.map(f => `- ${f.uri.fsPath}`);
	return `[workspace folders]\n${lines.join('\n')}`;
}

function referencesToBlock(refs: readonly vscode.ChatPromptReference[]): string {
	if (!refs.length) { return ''; }
	const lines = refs.map(
		r => (r.modelDescription ? `${r.modelDescription}\n${String(r.value)}` : String(r.value))
	);
	return `[attached references]\n${lines.join('\n\n---\n\n')}`;
}

function buildEditorBlock(editor: vscode.TextEditor, selectionOnly: boolean): string {
	const doc = editor.document;
	if (doc.uri.scheme !== 'file') { return ''; }
	let body: string;
	if (selectionOnly && !editor.selection.isEmpty) {
		body = doc.getText(editor.selection);
	} else {
		body = doc.getText();
	}
	if (body.length > MAX_ATTACHMENT_CHARS) {
		body = `${body.slice(0, MAX_ATTACHMENT_CHARS)}\n...[truncated]...`;
	}
	const rel = vscode.workspace.asRelativePath(doc.uri, false);
	const abs = doc.uri.fsPath;
	const label = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
	return `[Active editor]\npath: ${label}\nlanguage: ${doc.languageId}\n\n${body}`;
}

function chatHistoryToAiMessages(history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): AiMessage[] {
	const out: AiMessage[] = [];
	for (const t of history) {
		if (t instanceof vscode.ChatRequestTurn) {
			out.push({ role: 'user', content: t.prompt });
		} else if (t instanceof vscode.ChatResponseTurn) {
			const txt = chatResponseMarkdown(t.response);
			if (txt) {
				out.push({ role: 'assistant', content: txt });
			}
		}
	}
	return out;
}

function chatResponseMarkdown(
	parts: ReadonlyArray<
		vscode.ChatResponseMarkdownPart | vscode.ChatResponseFileTreePart | vscode.ChatResponseAnchorPart | vscode.ChatResponseProgressPart | vscode.ChatResponseReferencePart | vscode.ChatResponseCommandButtonPart
	>
): string {
	const buf: string[] = [];
	for (const part of parts) {
		if (part instanceof vscode.ChatResponseMarkdownPart) {
			const v = part.value;
			buf.push(typeof v === 'string' ? v : v.value);
		}
	}
	return buf.join('\n');
}

function vscodeLmRequestToAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): AiMessage[] {
	return messages.map(m => ({
		role: m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
		content: stringifyLmParts(m.content)
	}));
}

function stringifyLmParts(parts: readonly unknown[]): string {
	let s = '';
	for (const p of parts) {
		if (p instanceof vscode.LanguageModelTextPart) {
			s += p.value;
			continue;
		}
		const any = p as { value?: string; text?: string };
		if (typeof any?.value === 'string') {
			s += any.value;
		} else if (typeof any?.text === 'string') {
			s += any.text;
		}
	}
	return s.trim() || '[message]';
}
