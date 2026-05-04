/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	runChatRequest,
	type AiChatEvent,
	type AiProviderConfig,
	type AiMessage,
	type AiToolRunner
} from '../../../packages/ai-agent-core/src/index';
import { registerWorkbenchNativeChat } from './nativeChat';
import { createVsCodeAiToolRunner } from './vscodeToolRunner';
import { getTianAiProviderConfigFromWorkspace } from './workspaceAiConfig';

const MAX_ATTACHMENT_CHARS = 48_000;

type WebviewOutbound =
	| { type: 'log-clear' }
	| { type: 'log-line'; text: string }
	| { type: 'delta'; text: string }
	| { type: 'busy'; value: boolean }
	| { type: 'prefill'; text: string };

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Tian AI (output)');
	context.subscriptions.push(output);

	const toolRunner = createVsCodeAiToolRunner(context.secrets);
	registerWorkbenchNativeChat(context, toolRunner);
	const sidebar = new TianAiChatSidebarProvider(context.extensionUri, toolRunner);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('tian-ai.chat', sidebar, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tian-ai.openChat', async () => {
			await vscode.commands.executeCommand('tian-ai.chat.focus');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tian-ai.setApiKey', async () => {
			const providerId = await vscode.window.showInputBox({
				title: 'Provider (e.g. openai, anthropic, gemini)',
				value: 'openai'
			});
			if (!providerId) { return; }
			const key = await vscode.window.showInputBox({
				title: 'API key',
				password: true,
				prompt: `Stored: tian-ai.api-key.${providerId}`
			});
			if (!key) { return; }
			await context.secrets.store(`tian-ai.api-key.${providerId}`, key);
			vscode.window.showInformationMessage(`Tian AI: API key saved for ${providerId}.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tian-ai.chatToOutput', () =>
			runChatToOutputChannel(output, toolRunner)
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tian-ai.explainSelection', async () =>
			sidebar.explainSelection()
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('tian-ai.clearChatSidebar', async () => {
			await vscode.commands.executeCommand('tian-ai.chat.focus');
			sidebar.requestSidebarReset();
		})
	);
}

export function deactivate(): void { }

class TianAiChatSidebarProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | null = null;
	private readonly queuedPrefills: string[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly toolRunner: AiToolRunner
	) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const nonce = randomBytes(16).toString('hex');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = getSidebarHtml(webviewView.webview.cspSource, nonce);
		webviewView.onDidDispose(() => {
			this.view = null;
		});
		webviewView.webview.onDidReceiveMessage((msg: { type?: string; text?: string }) => {
			if (msg?.type === 'send' && typeof msg.text === 'string') {
				void this.runSidebarChat(msg.text.trim());
			}
		});
		this.flushQueuedPrefills();
	}

	requestSidebarReset(): void {
		this.post({ type: 'log-clear' });
		this.post({ type: 'prefill', text: '' });
	}

	async explainSelection(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('Tian AI: no active editor.');
			return;
		}
		const block = buildEditorBlock(editor, { selectionOnly: true });
		const body = block
			? `${block}\n\nExplain the above in context of this file. Be concise.`
			: 'Explain the current file (no text captured).';
		this.enqueuePrefill(body);
		await vscode.commands.executeCommand('tian-ai.chat.focus');
	}

	private enqueuePrefill(text: string): void {
		this.queuedPrefills.push(text);
		this.flushQueuedPrefills();
	}

	private flushQueuedPrefills(): void {
		const w = this.view?.webview;
		if (!w) { return; }
		while (this.queuedPrefills.length > 0) {
			const t = this.queuedPrefills.shift();
			if (t === undefined) { break; }
			void w.postMessage({ type: 'prefill', text: t });
		}
	}

	private post(m: WebviewOutbound): void {
		this.view?.webview.postMessage(m);
	}

	private async runSidebarChat(trimmed: string): Promise<void> {
		if (!trimmed) { return; }
		const v = this.view;
		if (!v) { return; }
		const folders = vscode.workspace.workspaceFolders;
		const root = folders?.[0]?.uri.fsPath ?? null;
		if (!root) {
			vscode.window.showWarningMessage('Open a folder workspace first.');
			return;
		}

		const cfg = vscode.workspace.getConfiguration('tian-ai');
		const includeEditor = cfg.get<boolean>('includeActiveEditor', true);
		const aiConfig: AiProviderConfig = getTianAiProviderConfigFromWorkspace();

		const requestId = `tian-ai-${Date.now()}`;
		const messageId = requestId;

		const editor = vscode.window.activeTextEditor;
		const editorBlock =
			includeEditor && editor && editor.document.uri.scheme === 'file'
				? buildEditorBlock(editor, { selectionOnly: false })
				: '';

		const userContent = [
			workspaceRootsPreamble(folders),
			editorBlock,
			trimmed
		]
			.filter(Boolean)
			.join('\n\n');

		this.post({ type: 'busy', value: true });
		this.post({ type: 'log-clear' });
		this.post({ type: 'log-line', text: `[workspace] ${root}` });
		if (folders && folders.length > 1) {
			this.post({
				type: 'log-line',
				text: `[roots] ${folders.map((f) => f.uri.fsPath).join('; ')}`
			});
		}
		this.post({ type: 'log-line', text: `[provider] ${aiConfig.provider} / ${aiConfig.model}` });
		if (editorBlock) {
			this.post({ type: 'log-line', text: '[context] active editor attached' });
		}
		this.post({ type: 'log-line', text: '---' });

		const messages: AiMessage[] = [{ role: 'user', content: userContent }];

		const sendEvent = (event: AiChatEvent): void => {
			if (event.type === 'response-delta') {
				this.post({ type: 'delta', text: event.delta });
				return;
			}
			if (event.type === 'tool-call-started') {
				this.post({ type: 'log-line', text: `[tool -> ${event.toolName}] ${event.summary ?? ''}` });
				return;
			}
			if (event.type === 'tool-call-completed') {
				this.post({
					type: 'log-line',
					text:
						`[tool ok ${event.toolName}] ok=${event.success}` +
						(event.details ? ` ${event.details.slice(0, 400)}...` : '')
				});
				return;
			}
			if (event.type === 'status-update') {
				this.post({ type: 'log-line', text: `[status] ${event.label}` });
				return;
			}
			if (event.type === 'response-error') {
				this.post({ type: 'log-line', text: `[error] ${event.error}` });
			}
		};

		try {
			await runChatRequest({
				requestId,
				messageId,
				messages,
				config: aiConfig,
				executionContext: { currentFolder: root },
				sendEvent,
				toolRunner: this.toolRunner
			});
		} catch (e) {
			this.post({ type: 'log-line', text: String(e instanceof Error ? e.message : e) });
		} finally {
			this.post({ type: 'busy', value: false });
		}
	}
}

function workspaceRootsPreamble(folders: readonly vscode.WorkspaceFolder[] | undefined): string {
	if (!folders?.length) { return ''; }
	if (folders.length === 1) { return ''; }
	const lines = folders.map((f) => `- ${f.uri.fsPath}`);
	return `This workspace has ${folders.length} roots:\n${lines.join('\n')}`;
}

function buildEditorBlock(
	editor: vscode.TextEditor,
	opts: { selectionOnly: boolean }
): string {
	const doc = editor.document;
	if (doc.uri.scheme !== 'file') { return ''; }
	let body: string;
	if (opts.selectionOnly && !editor.selection.isEmpty) {
		body = doc.getText(editor.selection);
	} else if (opts.selectionOnly && editor.selection.isEmpty) {
		body = doc.getText();
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

function getSidebarHtml(cspSource: string, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} https:;" />
<style nonce="${nonce}">
body{padding:10px;display:flex;flex-direction:column;gap:8px;margin:0;min-height:100%;
font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);
background:var(--vscode-sideBar-background);}
.row{display:flex;gap:6px;align-items:center;}
input{padding:6px 8px;flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);
border:1px solid var(--vscode-widget-border);}
button{padding:6px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
button:disabled{opacity:0.5;cursor:not-allowed;}
#log{flex:1;white-space:pre-wrap;word-break:break-word;background:var(--vscode-editor-background);padding:10px;
font-family:var(--vscode-editor-font-family,monospace);font-size:12px;overflow:auto;border:1px solid var(--vscode-widget-border);}
#log .meta{opacity:0.9;margin-bottom:4px;font-size:11px;}
#stream{white-space:pre-wrap;word-break:break-word;margin-top:8px;}
</style>
</head>
<body>
<p class="meta">Built-in Tian AI sidebar - context: settings <code>tian-ai.includeActiveEditor</code>.</p>
<div class="row">
<input type="text" id="prompt" placeholder="Message..." />
<button type="button" class="secondary" id="clear" title="Clear panel">Clear</button>
<button type="button" id="send">Send</button>
</div>
<div id="log"></div>
<script nonce="${nonce}">
(function(){
	var vscode = acquireVsCodeApi();
	var logEl = document.getElementById('log');
	var promptEl = document.getElementById('prompt');
	var btn = document.getElementById('send');
	var clearBtn = document.getElementById('clear');
	var streamEl = null;
	window.addEventListener('message', function(ev) {
		var m = ev.data;
		if (!m || !m.type) return;
		if (m.type === 'log-clear') { logEl.textContent = ''; streamEl = null; return; }
		if (m.type === 'busy') { btn.disabled = m.value; promptEl.disabled = m.value; clearBtn.disabled = m.value; return; }
		if (m.type === 'prefill') { promptEl.value = typeof m.text === 'string' ? m.text : ''; return; }
		if (m.type === 'log-line') {
			streamEl = null;
			var d = document.createElement('div');
			d.textContent = m.text;
			logEl.appendChild(d);
			logEl.scrollTop = logEl.scrollHeight;
			return;
		}
		if (m.type === 'delta') {
			if (!streamEl) { streamEl = document.createElement('div'); streamEl.id = 'stream'; logEl.appendChild(streamEl); }
			streamEl.textContent += m.text || '';
			logEl.scrollTop = logEl.scrollHeight;
		}
	});
	function submit() {
		var t = promptEl.value.trim();
		if (!t) return;
		promptEl.value = '';
		vscode.postMessage({ type: 'send', text: t });
	}
	function clearPanel() {
		logEl.textContent = '';
		streamEl = null;
	}
	btn.addEventListener('click', submit);
	clearBtn.addEventListener('click', clearPanel);
	promptEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
})();
</script>
</body>
</html>`;
}

async function runChatToOutputChannel(
	output: vscode.OutputChannel,
	toolRunner: AiToolRunner
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	const root = folders?.[0]?.uri.fsPath ?? null;
	if (!root) {
		vscode.window.showWarningMessage('Open a folder workspace first.');
		return;
	}

	const text = await vscode.window.showInputBox({
		title: 'Tian AI (output)',
		prompt: 'Agent loop - streamed to Output channel'
	});
	if (!text?.trim()) { return; }

	const cfg = vscode.workspace.getConfiguration('tian-ai');
	const includeEditor = cfg.get<boolean>('includeActiveEditor', true);
	const aiConfig: AiProviderConfig = getTianAiProviderConfigFromWorkspace();

	const requestId = `tian-ai-out-${Date.now()}`;
	const messageId = requestId;

	const editor = vscode.window.activeTextEditor;
	const editorBlock =
		includeEditor && editor && editor.document.uri.scheme === 'file'
			? buildEditorBlock(editor, { selectionOnly: false })
			: '';

	const userContent = [workspaceRootsPreamble(folders), editorBlock, text.trim()]
		.filter(Boolean)
		.join('\n\n');

	output.clear();
	output.show(true);
	output.appendLine(`[workspace] ${root}`);
	if (folders && folders.length > 1) {
		output.appendLine(`[roots] ${folders.map((f) => f.uri.fsPath).join('; ')}`);
	}
	output.appendLine(`[provider] ${aiConfig.provider} / ${aiConfig.model}`);
	if (editorBlock) { output.appendLine('[context] active editor attached'); }
	output.appendLine('---');

	const messages: AiMessage[] = [{ role: 'user', content: userContent }];

	const sendEvent = (event: AiChatEvent): void => {
		if (event.type === 'response-delta') {
			output.append(event.delta);
			return;
		}
		if (event.type === 'tool-call-started') {
			output.appendLine(`[tool -> ${event.toolName}] ${event.summary ?? ''}`);
			return;
		}
		if (event.type === 'tool-call-completed') {
			output.appendLine(
				`[tool ok ${event.toolName}] ok=${event.success}` +
				(event.details ? `\n${event.details.slice(0, 500)}...` : '')
			);
			return;
		}
		if (event.type === 'status-update') {
			output.appendLine(`[status] ${event.label}`);
			return;
		}
		if (event.type === 'response-error') {
			output.appendLine(`[error] ${event.error}`);
		}
	};

	try {
		await runChatRequest({
			requestId,
			messageId,
			messages,
			config: aiConfig,
			executionContext: { currentFolder: root },
			sendEvent,
			toolRunner
		});
		output.appendLine('\n--- done ---');
	} catch (e) {
		output.appendLine(String(e instanceof Error ? e.message : e));
	}
}
