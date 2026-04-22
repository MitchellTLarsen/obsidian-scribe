import {
  App,
  Component,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  ItemView,
  MarkdownRenderer,
  TFile,
  Notice,
  requestUrl,
  Editor,
  MarkdownView,
  Menu,
  Modal,
} from "obsidian";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface ScribeSettings {
  openaiApiKey: string;
  geminiApiKey: string;
  anthropicApiKey: string;
  groqApiKey: string;
  ollamaBaseUrl: string;
  defaultProvider: string;
  openaiModel: string;
  anthropicModel: string;
  groqModel: string;
  geminiModel: string;
  embeddingProvider: string;
  embeddingModel: string;
  includeFolders: string[];
  excludedFiles: string[];
  contextSize: number;
  showSources: boolean;
  confirmBeforeSend: boolean;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface Source {
  path: string;
  content: string;
  score: number;
  header?: string;
}

interface EmbeddingEntry {
  path: string;
  content: string;
  embedding: number[];
  header?: string;
}

interface Connection {
  path: string;
  score: number;
  matchingChunks: number;
  bestHeader?: string;
}

interface Flashcard {
  question: string;
  answer: string;
  source: string;
}

interface SearchResult {
  path: string;
  content: string;
  score: number;
  header?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SCRIBE_VIEW_TYPE = "scribe-chat-view";
const SCRIBE_CONNECTIONS_VIEW_TYPE = "scribe-connections-view";
const SCRIBE_SEARCH_VIEW_TYPE = "scribe-search-view";

const API_URLS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openaiEmbeddings: "https://api.openai.com/v1/embeddings",
  anthropic: "https://api.anthropic.com/v1/messages",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  gemini: (model: string, key: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
} as const;

const SYSTEM_PROMPT = `You are Archivist AI, an intelligent assistant with access to the user's notes vault and web content.

Your role is to:
1. Answer questions using the provided context (from vault notes or web pages)
2. Help organize and expand upon existing content
3. Generate new content that maintains consistency with existing materials
4. Assist with writing, editing, and brainstorming

The context section below contains relevant content that has been retrieved for you. This may include:
- Notes from the user's vault
- Content fetched from web pages (URLs the user provided)

When web content is included, it appears with "From Web:" in the header. You CAN and DO have access to this web content - it has already been fetched for you.

Always base your responses on the context provided when available.
Be concise and helpful.`;

const DEFAULT_SETTINGS: ScribeSettings = {
  openaiApiKey: "",
  geminiApiKey: "",
  anthropicApiKey: "",
  groqApiKey: "",
  ollamaBaseUrl: "http://localhost:11434",
  defaultProvider: "openai",
  openaiModel: "gpt-5.4-nano",
  anthropicModel: "claude-3-5-haiku-20241022",
  groqModel: "llama-3.3-70b-versatile",
  geminiModel: "gemini-2.5-flash-lite",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  includeFolders: [],
  excludedFiles: [],
  contextSize: 10,
  showSources: true,
  confirmBeforeSend: false,
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildContext(sources: Source[]): string {
  if (sources.length === 0) return "";

  let context = "## Relevant context:\n\n";
  for (const source of sources) {
    const isUrl = source.path.startsWith("http://") || source.path.startsWith("https://");
    context += isUrl ? `### From Web: ${source.path}` : `### From: ${source.path}`;
    if (source.header) context += ` (${source.header})`;
    context += `\n${source.content}\n\n`;
  }
  return context;
}

function simulateStreaming(
  content: string,
  onChunk: (chunk: string) => void,
  chunkSize = 3,
  delayMs = 20
): Promise<void> {
  return new Promise((resolve) => {
    const words = content.split(" ");
    let i = 0;

    const processChunk = () => {
      if (i >= words.length) {
        resolve();
        return;
      }
      const chunk = words.slice(i, i + chunkSize).join(" ") + " ";
      onChunk(chunk);
      i += chunkSize;
      setTimeout(processChunk, delayMs);
    };

    processChunk();
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  return text.match(urlRegex) || [];
}

function stripHtmlToText(html: string): string {
  // Remove script and style elements
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

async function fetchWebPage(url: string): Promise<{ title: string; content: string } | null> {
  try {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ObsidianPlugin/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      throw: false,
    });

    if (response.status >= 400) {
      return null;
    }

    const contentType = response.headers["content-type"] || "";
    const responseText = response.text;

    // Handle JSON responses
    if (contentType.includes("application/json") || responseText.trim().startsWith("{")) {
      try {
        const json = JSON.parse(responseText);
        // Try to extract meaningful text from common JSON structures
        const textContent = json.content || json.text || json.body || json.description ||
                           json.article?.content || json.data?.content ||
                           JSON.stringify(json, null, 2).slice(0, 3000);
        return {
          title: json.title || json.name || new URL(url).hostname,
          content: typeof textContent === "string" ? textContent.slice(0, 5000) : String(textContent).slice(0, 5000),
        };
      } catch {
        return { title: new URL(url).hostname, content: responseText.slice(0, 3000) };
      }
    }

    // Handle HTML responses
    const html = responseText;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;

    // Extract main content - try common content containers
    let content = html;

    // Try to find main content area
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
                      html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

    if (mainMatch) {
      content = mainMatch[1];
    }

    const text = stripHtmlToText(content);

    // Limit content length to avoid rate limiting
    return {
      title,
      content: text.slice(0, 5000),
    };
  } catch {
    return null;
  }
}

function getFileName(path: string): string {
  return path.split("/").pop()?.replace(".md", "") || path;
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export default class ScribePlugin extends Plugin {
  settings: ScribeSettings = DEFAULT_SETTINGS;
  embeddings: EmbeddingEntry[] = [];
  indexing = false;
  indexingCancelled = false;
  indexingStatus = "";
  indexingProgress = { current: 0, total: 0 };
  private pendingIndexQueue: Set<string> = new Set();
  private indexDebounceTimer: number | null = null;
  private saveDebounceTimer: number | null = null;
  private startupComplete = false; // Ignore file events during startup

  async onload() {
    console.log("[Archivist AI] Loading plugin...");
    await this.loadSettings();
    console.log(`[Archivist AI] Settings loaded. Provider: ${this.settings.defaultProvider}`);

    // Register views
    this.registerView(SCRIBE_VIEW_TYPE, (leaf) => new ScribeChatView(leaf, this));
    this.registerView(SCRIBE_CONNECTIONS_VIEW_TYPE, (leaf) => new ScribeConnectionsView(leaf, this));
    this.registerView(SCRIBE_SEARCH_VIEW_TYPE, (leaf) => new ScribeSearchView(leaf, this));

    // Ribbon icons
    this.addRibbonIcon("message-square", "Open chat", () => { void this.activateView(); });
    this.addRibbonIcon("git-branch", "Open connections", () => { void this.activateConnectionsView(); });
    this.addRibbonIcon("search", "Open semantic search", () => { void this.activateSearchView(); });

    // Core Commands
    this.addCommand({
      id: "open-scribe-chat",
      name: "Open chat",
      callback: () => { void this.activateView(); },
    });

    this.addCommand({
      id: "open-scribe-connections",
      name: "Open connections",
      callback: () => { void this.activateConnectionsView(); },
    });

    this.addCommand({
      id: "open-scribe-search",
      name: "Open semantic search",
      callback: () => { void this.activateSearchView(); },
    });

    this.addCommand({
      id: "index-vault",
      name: "Index vault for RAG",
      callback: () => { void this.indexVault(); },
    });

    // Writing Commands
    this.addCommand({
      id: "summarize-note",
      name: "Summarize current note",
      editorCallback: (editor: Editor, ctx) => {
        if (ctx instanceof MarkdownView) void this.summarizeNote(editor);
      },
    });

    this.addCommand({
      id: "summarize-selection",
      name: "Summarize selection",
      editorCallback: (editor: Editor) => { void this.summarizeSelection(editor); },
    });

    this.addCommand({
      id: "continue-writing",
      name: "Continue writing from cursor",
      editorCallback: (editor: Editor) => { void this.continueWriting(editor); },
    });

    this.addCommand({
      id: "expand-selection",
      name: "Expand/elaborate on selection",
      editorCallback: (editor: Editor) => { void this.expandSelection(editor); },
    });

    this.addCommand({
      id: "simplify-selection",
      name: "Simplify selection",
      editorCallback: (editor: Editor) => { void this.simplifySelection(editor); },
    });

    this.addCommand({
      id: "fix-grammar",
      name: "Fix grammar and spelling",
      editorCallback: (editor: Editor) => { void this.fixGrammar(editor); },
    });

    // Organization Commands
    this.addCommand({
      id: "suggest-tags",
      name: "Suggest tags for current note",
      editorCallback: (_editor: Editor, ctx) => {
        if (ctx instanceof MarkdownView) void this.suggestTags(ctx);
      },
    });

    this.addCommand({
      id: "suggest-links",
      name: "Suggest backlinks for current note",
      callback: () => { void this.suggestBacklinks(); },
    });

    this.addCommand({
      id: "find-duplicates",
      name: "Find similar/duplicate notes",
      callback: () => { void this.findDuplicates(); },
    });

    this.addCommand({
      id: "find-orphans",
      name: "Find orphan notes (no connections)",
      callback: () => { void this.findOrphans(); },
    });

    // Generation Commands
    this.addCommand({
      id: "generate-note",
      name: "Generate note from topic",
      callback: () => { this.showGenerateNoteModal(); },
    });

    this.addCommand({
      id: "generate-flashcards",
      name: "Generate flashcards from current note",
      editorCallback: (_editor: Editor, ctx) => {
        if (ctx instanceof MarkdownView) void this.generateFlashcards(ctx);
      },
    });

    this.addCommand({
      id: "generate-outline",
      name: "Generate outline for topic",
      callback: () => { this.showOutlineModal(); },
    });

    // Chat Commands
    this.addCommand({
      id: "save-chat-history",
      name: "Save current chat as note",
      callback: () => { void this.saveChatHistory(); },
    });

    // Context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        this.addEditorContextMenu(menu, editor, view);
      })
    );

    this.addSettingTab(new ScribeSettingTab(this.app, this));
    await this.loadEmbeddings();

    // Update connections view when active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateConnectionsView();
      })
    );

    // Auto-index on file changes (after startup completes)
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!this.startupComplete) return;
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileForIndexing(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.startupComplete) return;
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileForIndexing(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.startupComplete) return;
        if (file instanceof TFile && file.extension === "md") {
          this.removeFileFromIndex(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.startupComplete) return;
        if (file instanceof TFile && file.extension === "md") {
          this.removeFileFromIndex(oldPath);
          this.queueFileForIndexing(file.path);
        }
      })
    );

    // Mark startup complete after a delay to ignore initial file events
    window.setTimeout(() => {
      this.startupComplete = true;
      // Auto-indexing now enabled
    }, 10000); // 10 second delay after plugin load
  }

  async activateView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(SCRIBE_VIEW_TYPE);

    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SCRIBE_VIEW_TYPE, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  async activateConnectionsView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(SCRIBE_CONNECTIONS_VIEW_TYPE);

    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SCRIBE_CONNECTIONS_VIEW_TYPE, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  updateConnectionsView() {
    const leaves = this.app.workspace.getLeavesOfType(SCRIBE_CONNECTIONS_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as ScribeConnectionsView;
      if (view && view.refresh) {
        view.refresh();
      }
    }
  }

  async activateSearchView() {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(SCRIBE_SEARCH_VIEW_TYPE);

    if (leaves.length > 0) {
      workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SCRIBE_SEARCH_VIEW_TYPE, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  // ============================================================================
  // WRITING COMMANDS
  // ============================================================================

  async summarizeNote(editor: Editor) {
    const content = editor.getValue();
    if (!content.trim()) {
      new Notice("Note is empty");
      return;
    }

    const notice = new Notice("Summarizing note...", 0);

    try {
      const summary = await this.chat(
        "Please provide a concise summary of the following note. Focus on the key points and main ideas:\n\n" + content,
        [],
        []
      );

      notice.hide();
      new ScribeResultModal(this.app, summary, "Note summary").open();
    } catch (e) {
      notice.hide();
      new Notice(`Failed to summarize: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async summarizeSelection(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("No text selected");
      return;
    }

    const notice = new Notice("Summarizing selection...", 0);

    try {
      const summary = await this.chat(
        "Please provide a concise summary of the following text:\n\n" + selection,
        [],
        []
      );

      notice.hide();
      new ScribeResultModal(this.app, summary, "Selection summary").open();
    } catch (e) {
      notice.hide();
      new Notice(`Failed to summarize: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async continueWriting(editor: Editor) {
    const cursor = editor.getCursor();
    const textBeforeCursor = editor.getRange({ line: 0, ch: 0 }, cursor);

    if (!textBeforeCursor.trim()) {
      new Notice("Write some content first");
      return;
    }

    const notice = new Notice("Continuing writing...", 0);

    try {
      // Get relevant context from vault
      const lastParagraph = textBeforeCursor.split("\n\n").pop() || textBeforeCursor;
      const sources = await this.search(lastParagraph, 3);

      const continuation = await this.chat(
        `Continue writing naturally from where this text ends. Match the style and tone. Don't repeat what's already written:\n\n${textBeforeCursor.slice(-2000)}`,
        sources,
        []
      );

      notice.hide();
      editor.replaceRange("\n\n" + continuation, cursor);
    } catch (e) {
      notice.hide();
      new Notice(`Failed to continue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async expandSelection(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("No text selected");
      return;
    }

    const notice = new Notice("Expanding text...", 0);

    try {
      const sources = await this.search(selection, 3);
      const expanded = await this.chat(
        `Expand and elaborate on the following text with more detail, examples, or explanation. Use context from related notes if relevant:\n\n${selection}`,
        sources,
        []
      );

      notice.hide();
      editor.replaceSelection(expanded);
    } catch (e) {
      notice.hide();
      new Notice(`Failed to expand: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async simplifySelection(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("No text selected");
      return;
    }

    const notice = new Notice("Simplifying text...", 0);

    try {
      const simplified = await this.chat(
        `Simplify the following text to make it clearer and easier to understand while keeping the core meaning:\n\n${selection}`,
        [],
        []
      );

      notice.hide();
      editor.replaceSelection(simplified);
    } catch (e) {
      notice.hide();
      new Notice(`Failed to simplify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async fixGrammar(editor: Editor) {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice("No text selected");
      return;
    }

    const notice = new Notice("Fixing grammar...", 0);

    try {
      const fixed = await this.chat(
        `Fix any grammar, spelling, and punctuation errors in the following text. Keep the original meaning and style:\n\n${selection}`,
        [],
        []
      );

      notice.hide();
      editor.replaceSelection(fixed);
    } catch (e) {
      notice.hide();
      new Notice(`Failed to fix grammar: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ============================================================================
  // ORGANIZATION COMMANDS
  // ============================================================================

  async suggestTags(view: MarkdownView) {
    const content = view.editor.getValue();
    if (!content.trim()) {
      new Notice("Note is empty");
      return;
    }

    const notice = new Notice("Analyzing note for tags...", 0);

    try {
      // Get existing tags from vault for context
      const allTags = new Set<string>();
      this.app.vault.getMarkdownFiles().forEach((file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.tags) {
          cache.tags.forEach((t) => allTags.add(t.tag));
        }
      });

      const existingTags = Array.from(allTags).slice(0, 50).join(", ");

      const suggestions = await this.chat(
        `Suggest relevant tags for this note. Consider existing tags in the vault: ${existingTags}\n\nNote content:\n${content.slice(0, 3000)}\n\nProvide 3-5 tags in the format: #tag1, #tag2, #tag3`,
        [],
        []
      );

      notice.hide();
      new ScribeResultModal(this.app, suggestions, "Suggested tags").open();
    } catch (e) {
      notice.hide();
      new Notice(`Failed to suggest tags: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async suggestBacklinks() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file");
      return;
    }

    const connections = this.findSimilarNotes(activeFile.path, 10);
    if (connections.length === 0) {
      new Notice("No similar notes found. Try indexing your vault first.");
      return;
    }

    // Filter to notes not already linked
    const content = await this.app.vault.read(activeFile);
    const unlinked = connections.filter((c) => !content.includes(`[[${getFileName(c.path)}]]`));

    if (unlinked.length === 0) {
      new Notice("All similar notes are already linked!");
      return;
    }

    new BacklinkSuggestionsModal(this.app, unlinked, activeFile).open();
  }

  findDuplicates() {
    if (this.embeddings.length === 0) {
      new Notice("Index your vault first");
      return;
    }

    this.findDuplicatesInternal();
  }

  private findDuplicatesInternal() {

    const notice = new Notice("Finding duplicates...", 0);

    // Group embeddings by file
    const fileEmbeddings = new Map<string, number[][]>();
    for (const entry of this.embeddings) {
      const existing = fileEmbeddings.get(entry.path) || [];
      existing.push(entry.embedding);
      fileEmbeddings.set(entry.path, existing);
    }

    // Calculate average embeddings per file
    const fileAvgEmbeddings: Array<{ path: string; embedding: number[] }> = [];
    for (const [path, embeddings] of fileEmbeddings) {
      const avg = this.averageEmbeddings(embeddings);
      fileAvgEmbeddings.push({ path, embedding: avg });
    }

    // Find highly similar pairs
    const duplicates: Array<{ path1: string; path2: string; score: number }> = [];
    for (let i = 0; i < fileAvgEmbeddings.length; i++) {
      for (let j = i + 1; j < fileAvgEmbeddings.length; j++) {
        const score = cosineSimilarity(fileAvgEmbeddings[i].embedding, fileAvgEmbeddings[j].embedding);
        if (score > 0.85) {
          duplicates.push({
            path1: fileAvgEmbeddings[i].path,
            path2: fileAvgEmbeddings[j].path,
            score: Math.round(score * 100),
          });
        }
      }
    }

    notice.hide();

    if (duplicates.length === 0) {
      new Notice("No duplicate notes found");
      return;
    }

    duplicates.sort((a, b) => b.score - a.score);
    new DuplicatesModal(this.app, duplicates).open();
  }

  findOrphans() {
    if (this.embeddings.length === 0) {
      new Notice("Index your vault first");
      return;
    }

    this.findOrphansInternal();
  }

  private findOrphansInternal() {

    const notice = new Notice("Finding orphan notes...", 0);

    // Get all indexed files
    const indexedFiles = new Set(this.embeddings.map((e) => e.path));

    // Find files with no strong connections
    const orphans: Array<{ path: string; maxScore: number }> = [];

    for (const filePath of indexedFiles) {
      const connections = this.findSimilarNotes(filePath, 5);
      const maxScore = connections.length > 0 ? Math.max(...connections.map((c) => c.score)) : 0;

      if (maxScore < 40) {
        orphans.push({ path: filePath, maxScore });
      }
    }

    notice.hide();

    if (orphans.length === 0) {
      new Notice("No orphan notes found - all notes are connected!");
      return;
    }

    orphans.sort((a, b) => a.maxScore - b.maxScore);
    new OrphansModal(this.app, orphans).open();
  }

  // ============================================================================
  // GENERATION COMMANDS
  // ============================================================================

  showGenerateNoteModal() {
    new GenerateNoteModal(this.app, this).open();
  }

  async generateNoteFromTopic(topic: string, folder?: string): Promise<TFile | null> {
    const notice = new Notice("Generating note...", 0);

    try {
      // Get relevant context
      const sources = await this.search(topic, 5);

      const content = await this.chat(
        `Create a comprehensive note about: ${topic}\n\nUse relevant information from the provided context. Format with proper markdown headings, bullet points, and sections.`,
        sources,
        []
      );

      notice.hide();

      // Create the file
      const safeName = topic.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 50);
      const fileName = `${safeName}.md`;
      const filePath = folder ? `${folder}/${fileName}` : fileName;

      const file = await this.app.vault.create(filePath, `# ${topic}\n\n${content}`);
      new Notice(`Created: ${filePath}`);

      return file;
    } catch (e) {
      notice.hide();
      new Notice(`Failed to generate: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async generateFlashcards(view: MarkdownView) {
    const content = view.editor.getValue();
    if (!content.trim()) {
      new Notice("Note is empty");
      return;
    }

    const notice = new Notice("Generating flashcards...", 0);

    try {
      const flashcardsText = await this.chat(
        `Create flashcards from this note content. Format each as:
Q: [question]
A: [answer]

Create 5-10 flashcards covering the key concepts:\n\n${content.slice(0, 4000)}`,
        [],
        []
      );

      notice.hide();

      // Parse flashcards
      const flashcards: Flashcard[] = [];
      const lines = flashcardsText.split("\n");
      let currentQ = "";

      for (const line of lines) {
        if (line.startsWith("Q:")) {
          currentQ = line.slice(2).trim();
        } else if (line.startsWith("A:") && currentQ) {
          flashcards.push({
            question: currentQ,
            answer: line.slice(2).trim(),
            source: view.file?.path || "unknown",
          });
          currentQ = "";
        }
      }

      if (flashcards.length === 0) {
        new Notice("Could not generate flashcards");
        return;
      }

      new FlashcardsModal(this.app, flashcards, this).open();
    } catch (e) {
      notice.hide();
      new Notice(`Failed to generate flashcards: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  showOutlineModal() {
    new OutlineModal(this.app, this).open();
  }

  async generateOutline(topic: string): Promise<string> {
    const sources = await this.search(topic, 5);

    return this.chat(
      `Create a detailed outline for: ${topic}\n\nUse the provided context for relevant information. Format with proper markdown headings and subheadings.`,
      sources,
      []
    );
  }

  // ============================================================================
  // CHAT COMMANDS
  // ============================================================================

  async saveChatHistory() {
    const leaves = this.app.workspace.getLeavesOfType(SCRIBE_VIEW_TYPE);
    if (leaves.length === 0) {
      new Notice("No chat open");
      return;
    }

    const chatView = leaves[0].view as ScribeChatView;
    const messages = chatView.messages;

    if (messages.length === 0) {
      new Notice("No messages to save");
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const fileName = `Chat_${timestamp}.md`;

    let content = `# Chat History\n\n> Saved on ${new Date().toLocaleString()}\n\n---\n\n`;

    for (const msg of messages) {
      const role = msg.role === "user" ? "**You**" : "**Scribe**";
      content += `${role}:\n\n${msg.content}\n\n---\n\n`;
    }

    const file = await this.app.vault.create(fileName, content);
    new Notice(`Saved to ${fileName}`);
    this.app.workspace.getLeaf(false).openFile(file);
  }

  // ============================================================================
  // CONTEXT MENU
  // ============================================================================

  addEditorContextMenu(menu: Menu, editor: Editor, view: MarkdownView) {
    const selection = editor.getSelection();

    menu.addSeparator();

    if (selection) {
      menu.addItem((item) =>
        item
          .setTitle("Scribe: Summarize")
          .setIcon("file-text")
          .onClick(() => { void this.summarizeSelection(editor); })
      );

      menu.addItem((item) =>
        item
          .setTitle("Scribe: Expand")
          .setIcon("maximize-2")
          .onClick(() => { void this.expandSelection(editor); })
      );

      menu.addItem((item) =>
        item
          .setTitle("Scribe: Simplify")
          .setIcon("minimize-2")
          .onClick(() => { void this.simplifySelection(editor); })
      );

      menu.addItem((item) =>
        item
          .setTitle("Scribe: Fix grammar")
          .setIcon("check")
          .onClick(() => { void this.fixGrammar(editor); })
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle("Scribe: Continue writing")
          .setIcon("edit")
          .onClick(() => { void this.continueWriting(editor); })
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("Scribe: Suggest tags")
        .setIcon("tag")
        .onClick(() => {
          if (view instanceof MarkdownView) void this.suggestTags(view);
        })
    );

  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migrate old string-based settings to arrays
    if (typeof this.settings.includeFolders === "string") {
      const str = this.settings.includeFolders as unknown as string;
      this.settings.includeFolders = str ? str.split(",").map((s) => s.trim()).filter(Boolean) : [];
    }
    if (typeof this.settings.excludedFiles === "string") {
      const str = this.settings.excludedFiles as unknown as string;
      this.settings.excludedFiles = str ? str.split(",").map((s) => s.trim()).filter(Boolean) : [];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ============================================================================
  // EMBEDDING & INDEXING
  // ============================================================================

  private get embeddingsCachePath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/embeddings.json`;
  }

  async loadEmbeddings() {
    console.log(`[Embeddings] Loading from: ${this.embeddingsCachePath}`);
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.embeddingsCachePath)) {
        const data = await adapter.read(this.embeddingsCachePath);
        this.embeddings = JSON.parse(data);
        console.log(`[Embeddings] Loaded ${this.embeddings.length} embeddings from cache`);
      } else {
        console.log("[Embeddings] No cache found");
      }
    } catch (error) {
      console.error("[Embeddings] Failed to load cache:", error);
    }
  }

  async saveEmbeddings() {
    console.log(`[Embeddings] Saving ${this.embeddings.length} embeddings to: ${this.embeddingsCachePath}`);
    try {
      await this.app.vault.adapter.write(this.embeddingsCachePath, JSON.stringify(this.embeddings));
      console.log("[Embeddings] Saved successfully");
    } catch (error) {
      console.error("[Embeddings] Failed to save:", error);
    }
  }

  private debouncedSaveEmbeddings() {
    if (this.saveDebounceTimer) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      void this.saveEmbeddings();
      this.saveDebounceTimer = null;
    }, 5000); // Save after 5 seconds of inactivity
  }

  // ============================================================================
  // AUTO-INDEXING
  // ============================================================================

  private shouldIndexFile(filePath: string): boolean {
    const { includeFolders, excludedFiles } = this.settings;

    // Check include folders
    if (includeFolders.length > 0 && !includeFolders.some((folder) => filePath.startsWith(folder))) {
      return false;
    }

    // Check excluded files
    const fileName = filePath.split("/").pop() || "";
    if (excludedFiles.includes(fileName)) {
      return false;
    }

    return true;
  }

  queueFileForIndexing(filePath: string) {
    if (!this.shouldIndexFile(filePath)) return;
    if (!this.settings.openaiApiKey) return; // Need API key for embeddings

    this.pendingIndexQueue.add(filePath);

    // Debounce to batch multiple quick edits
    if (this.indexDebounceTimer) {
      window.clearTimeout(this.indexDebounceTimer);
    }

    this.indexDebounceTimer = window.setTimeout(() => {
      void this.processIndexQueue();
      this.indexDebounceTimer = null;
    }, 2000); // Wait 2 seconds after last change
  }

  private async processIndexQueue() {
    if (this.pendingIndexQueue.size === 0) return;
    if (this.indexing) {
      // If full indexing is running, wait and try again
      setTimeout(() => { void this.processIndexQueue(); }, 5000);
      return;
    }

    const filesToIndex = Array.from(this.pendingIndexQueue);
    this.pendingIndexQueue.clear();

    const total = filesToIndex.length;
    const notice = new Notice(`Re-indexing ${total} file(s)...`, 0);

    let indexed = 0;
    let failed = 0;

    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i];
      const fileName = getFileName(filePath);
      notice.setMessage(`Re-indexing (${i + 1}/${total}): ${fileName}`);

      const success = await this.indexSingleFile(filePath);
      if (success) {
        indexed++;
      } else {
        failed++;
      }
    }

    notice.hide();

    // Show completion notice
    if (failed > 0) {
      new Notice(`Re-indexed ${indexed} file(s), ${failed} failed`, 3000);
    } else {
      new Notice(`Re-indexed ${indexed} file(s)`, 2000);
    }

    this.debouncedSaveEmbeddings();
    this.updateConnectionsView();
  }

  async indexSingleFile(filePath: string, showNotice = false): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return false;

    const notice = showNotice ? new Notice(`Indexing: ${getFileName(filePath)}...`, 0) : null;

    try {
      // Remove existing embeddings for this file
      this.embeddings = this.embeddings.filter((e) => e.path !== filePath);

      // Read and chunk the file
      const content = await this.app.vault.read(file);
      const chunks = this.chunkText(content);

      if (chunks.length === 0) {
        notice?.hide();
        return false;
      }

      // Create embeddings for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (notice && chunks.length > 1) {
          notice.setMessage(`Indexing: ${getFileName(filePath)} (${i + 1}/${chunks.length})`);
        }

        const embedding = await this.createEmbedding(chunk.content);
        if (embedding) {
          this.embeddings.push({
            path: filePath,
            content: chunk.content,
            embedding,
            header: chunk.header,
          });
        }
      }

      notice?.hide();
      // File indexed successfully
      return true;
    } catch {
      notice?.hide();
      // Failed to index file
      return false;
    }
  }

  removeFileFromIndex(filePath: string) {
    const before = this.embeddings.length;
    this.embeddings = this.embeddings.filter((e) => e.path !== filePath);
    const removed = before - this.embeddings.length;

    if (removed > 0) {
      new Notice(`Removed: ${getFileName(filePath)}`, 1500);
      // Embeddings removed for deleted file
      this.debouncedSaveEmbeddings();
      this.updateConnectionsView();
    }
  }

  cancelIndexing() {
    if (this.indexing) {
      this.indexingCancelled = true;
      new Notice("Cancelling indexing...");
    }
  }

  async indexVault() {
    if (this.indexing) {
      new Notice("Already indexing...");
      return;
    }

    console.log("[Index] Starting vault indexing...");
    this.indexing = true;
    this.indexingCancelled = false;
    this.indexingStatus = "Starting...";
    this.indexingProgress = { current: 0, total: 0 };

    const currentNotice = new Notice("Starting indexing...", 0);
    const { includeFolders, excludedFiles } = this.settings;

    const filesToIndex = this.app.vault.getMarkdownFiles().filter((file) => {
      if (includeFolders.length > 0 && !includeFolders.some((folder) => file.path.startsWith(folder))) {
        return false;
      }
      return !excludedFiles.includes(file.name);
    });

    console.log(`[Index] Found ${filesToIndex.length} files to index`);
    console.log(`[Index] Include folders: ${includeFolders.length > 0 ? includeFolders.join(", ") : "all"}`);
    console.log(`[Index] Excluded files: ${excludedFiles.join(", ") || "none"}`);
    this.indexingProgress.total = filesToIndex.length;
    this.embeddings = [];

    for (let i = 0; i < filesToIndex.length; i++) {
      if (this.indexingCancelled) {
        this.indexingStatus = `Cancelled at ${i}/${filesToIndex.length} files`;
        break;
      }

      const file = filesToIndex[i];
      this.indexingProgress.current = i + 1;
      this.indexingStatus = `${i + 1}/${filesToIndex.length} - ${file.name}`;
      currentNotice.setMessage(`Indexing: ${this.indexingStatus}`);

      try {
        const content = await this.app.vault.read(file);
        const chunks = this.chunkText(content);

        for (let j = 0; j < chunks.length; j++) {
          if (this.indexingCancelled) break;

          const chunk = chunks[j];
          if (chunks.length > 3) {
            this.indexingStatus = `${i + 1}/${filesToIndex.length} - ${file.name} (chunk ${j + 1}/${chunks.length})`;
            currentNotice.setMessage(`Indexing: ${this.indexingStatus}`);
          }

          const embedding = await this.createEmbedding(chunk.content);
          if (embedding) {
            this.embeddings.push({
              path: file.path,
              content: chunk.content,
              embedding,
              header: chunk.header,
            });
          }
        }
      } catch {
        // Failed to index file, continuing
      }
    }

    if (this.embeddings.length > 0) {
      console.log(`[Index] Saving ${this.embeddings.length} embeddings...`);
      await this.saveEmbeddings();
      console.log("[Index] Embeddings saved successfully");
    }

    this.indexing = false;
    this.indexingStatus = this.indexingCancelled
      ? `Cancelled. Saved ${this.embeddings.length} chunks.`
      : `Done! ${this.embeddings.length} chunks from ${filesToIndex.length} files`;

    console.log(`[Index] ${this.indexingStatus}`);
    currentNotice.hide();
    new Notice(this.indexingStatus, 5000);
  }

  chunkText(text: string): { content: string; header?: string }[] {
    const chunks: { content: string; header?: string }[] = [];
    const lines = text.split("\n");
    let currentChunk: string[] = [];
    let currentHeader = "";
    let currentSize = 0;
    const maxSize = 1000;
    const minSize = 50;

    for (const line of lines) {
      if (line.startsWith("#")) {
        if (currentChunk.length > 0 && currentSize > minSize) {
          chunks.push({ content: currentChunk.join("\n"), header: currentHeader });
        }
        currentChunk = [line];
        currentHeader = line.replace(/^#+\s*/, "").trim();
        currentSize = line.length;
      } else {
        currentChunk.push(line);
        currentSize += line.length;

        if (currentSize > maxSize) {
          chunks.push({ content: currentChunk.join("\n"), header: currentHeader });
          currentChunk = [];
          currentSize = 0;
        }
      }
    }

    if (currentChunk.length > 0 && currentSize > minSize) {
      chunks.push({ content: currentChunk.join("\n"), header: currentHeader });
    }

    return chunks;
  }

  async createEmbedding(text: string): Promise<number[] | null> {
    if (this.settings.embeddingProvider !== "openai" || !this.settings.openaiApiKey) {
      return null;
    }

    try {
      const response = await requestUrl({
        url: API_URLS.openaiEmbeddings,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${this.settings.openaiApiKey.trim()}` },
        body: JSON.stringify({
          model: this.settings.embeddingModel,
          input: text.slice(0, 8000),
        }),
        throw: false,
      });

      if (response.status >= 400) {
        // Embedding API error, retrying
        await delay(2000);
        return null;
      }

      if (response.text?.trim().startsWith("<")) {
        // Embedding API returned HTML - network issue
        await delay(2000);
        return null;
      }

      await delay(100); // Rate limiting

      const data = response.json;
      return data?.data?.[0]?.embedding ?? null;
    } catch {
      // Embedding request failed
      await delay(2000);
      return null;
    }
  }

  // ============================================================================
  // SEARCH & RAG
  // ============================================================================

  async search(query: string, limit = 10): Promise<Source[]> {
    if (this.embeddings.length === 0) return [];

    const queryEmbedding = await this.createEmbedding(query);
    if (!queryEmbedding) return [];

    return this.embeddings
      .map((entry) => ({
        ...entry,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        path: s.path,
        content: s.content,
        score: Math.round(s.score * 100),
        header: s.header,
      }));
  }

  async getFullVaultContent(): Promise<Source[]> {
    const { includeFolders, excludedFiles } = this.settings;
    const sources: Source[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      // Apply folder filter
      if (includeFolders.length > 0 && !includeFolders.some((folder) => file.path.startsWith(folder))) {
        continue;
      }

      // Apply file exclusion filter
      if (excludedFiles.includes(file.name)) {
        continue;
      }

      const content = await this.app.vault.read(file);
      sources.push({ path: file.path, content, score: 100 });
    }

    return sources;
  }

  findSimilarNotes(filePath: string, limit = 20): Connection[] {
    if (this.embeddings.length === 0) return [];

    // Get all embeddings for the current file
    const fileEmbeddings = this.embeddings.filter((e) => e.path === filePath);
    if (fileEmbeddings.length === 0) return [];

    // Calculate average embedding for the file
    const avgEmbedding = this.averageEmbeddings(fileEmbeddings.map((e) => e.embedding));

    // Find similar notes (excluding the current file)
    const otherEmbeddings = this.embeddings.filter((e) => e.path !== filePath);

    // Group by file and calculate best match
    const fileScores = new Map<string, { scores: number[]; headers: string[] }>();

    for (const entry of otherEmbeddings) {
      const score = cosineSimilarity(avgEmbedding, entry.embedding);
      const existing = fileScores.get(entry.path) || { scores: [], headers: [] };
      existing.scores.push(score);
      if (entry.header) existing.headers.push(entry.header);
      fileScores.set(entry.path, existing);
    }

    // Convert to connections array
    const connections: Connection[] = [];
    for (const [path, data] of fileScores) {
      const maxScore = Math.max(...data.scores);
      const avgScore = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
      // Weight towards max score but consider average
      const combinedScore = maxScore * 0.7 + avgScore * 0.3;

      connections.push({
        path,
        score: Math.round(combinedScore * 100),
        matchingChunks: data.scores.filter((s) => s > 0.5).length,
        bestHeader: data.headers[data.scores.indexOf(maxScore)],
      });
    }

    return connections.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private averageEmbeddings(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];
    if (embeddings.length === 1) return embeddings[0];

    const dim = embeddings[0].length;
    const avg = new Array(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        avg[i] += emb[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      avg[i] /= embeddings.length;
    }

    return avg;
  }

  // ============================================================================
  // AI CHAT
  // ============================================================================

  getModelForProvider(provider: string): string {
    const models: Record<string, string> = {
      openai: this.settings.openaiModel,
      anthropic: this.settings.anthropicModel,
      groq: this.settings.groqModel,
      gemini: this.settings.geminiModel,
    };
    return models[provider] || "gpt-4o-mini";
  }

  async chat(message: string, sources: Source[], history: Message[], provider?: string, model?: string): Promise<string> {
    const useProvider = provider || this.settings.defaultProvider;
    const useModel = model || this.getModelForProvider(useProvider);
    const context = buildContext(sources);

    console.log(`[Chat] Provider: ${useProvider}, Model: ${useModel}`);
    console.log(`[Chat] Sources: ${sources.length}, History: ${history.length} messages`);
    console.log(`[Chat] Context length: ${context.length} chars`);

    const handlers: Record<string, () => Promise<string>> = {
      openai: () => this.chatOpenAI(message, context, history, useModel),
      gemini: () => this.chatGemini(message, context, history, useModel),
      anthropic: () => this.chatAnthropic(message, context, history, useModel),
      groq: () => this.chatGroq(message, context, history, useModel),
    };

    const handler = handlers[useProvider];
    if (!handler) {
      console.error(`[Chat] Unknown provider: ${useProvider}`);
      throw new Error(`Provider ${useProvider} not configured. Please add API key in settings.`);
    }

    const startTime = Date.now();
    const result = await handler();
    console.log(`[Chat] Response received in ${Date.now() - startTime}ms, length: ${result.length} chars`);
    return result;
  }

  private async chatOpenAI(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.openaiApiKey) throw new Error("OpenAI API key not configured");

    const messages: Message[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const body = JSON.stringify({ model, messages });
    console.log(`[OpenAI] Model: ${model}, Messages: ${messages.length}, Body size: ${body.length} bytes`);
    console.log(`[OpenAI] Context size: ${context.length} chars, Message: ${message.slice(0, 100)}...`);

    try {
      const response = await requestUrl({
        url: API_URLS.openai,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      console.log(`[OpenAI] Response received, status: ${response.status}`);
      return response.json.choices[0].message.content;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("[OpenAI] Error:", errMsg);
      throw new Error(`OpenAI error: ${errMsg}`);
    }
  }

  private async chatGemini(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.geminiApiKey) throw new Error("Gemini API key not configured");

    // Build conversation history for Gemini
    let historyText = "";
    for (const msg of history.slice(-10)) {
      const role = msg.role === "user" ? "User" : "Assistant";
      historyText += `${role}: ${msg.content}\n\n`;
    }

    const fullPrompt = `${SYSTEM_PROMPT}\n\n${context}\n\n${historyText}User: ${message}\n\nAssistant:`;
    const url = API_URLS.gemini(model, this.settings.geminiApiKey);
    const body = JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] });

    console.log(`[Gemini] Model: ${model}, Prompt size: ${fullPrompt.length} chars, Body size: ${body.length} bytes`);
    console.log(`[Gemini] URL: ${url.replace(this.settings.geminiApiKey, "API_KEY_HIDDEN")}`);

    try {
      const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      console.log("[Gemini] Response received:", response.status);

      if (!response.json.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.log("[Gemini] Invalid response:", JSON.stringify(response.json).slice(0, 500));
        throw new Error(`Invalid response from Gemini. Model "${model}" may not be available.`);
      }

      return response.json.candidates[0].content.parts[0].text;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("[Gemini] Error:", errMsg);
      if (errMsg.includes("ERR_CONNECTION") || errMsg.includes("net::")) {
        throw new Error(`Connection error with Gemini (${model}). Check console for details. Try gemini-2.5-flash.`);
      }
      throw new Error(`Gemini error: ${errMsg}`);
    }
  }

  private async chatAnthropic(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.anthropicApiKey) throw new Error("Anthropic API key not configured");

    const messages = [
      ...history.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      system: `${SYSTEM_PROMPT}\n\n${context}`,
      messages,
    });

    console.log(`[Anthropic] Model: ${model}, Messages: ${messages.length}, Body size: ${body.length} bytes`);
    console.log(`[Anthropic] Context size: ${context.length} chars, Message: ${message.slice(0, 100)}...`);

    try {
      const response = await requestUrl({
        url: API_URLS.anthropic,
        method: "POST",
        headers: {
          "x-api-key": this.settings.anthropicApiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body,
      });

      console.log(`[Anthropic] Response received, status: ${response.status}`);
      return response.json.content[0].text;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("[Anthropic] Error:", errMsg);
      throw new Error(`Anthropic error: ${errMsg}`);
    }
  }

  private async chatGroq(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.groqApiKey) throw new Error("Groq API key not configured");

    const messages: Message[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const body = JSON.stringify({ model, messages });
    console.log(`[Groq] Model: ${model}, Messages: ${messages.length}, Body size: ${body.length} bytes`);
    console.log(`[Groq] Context size: ${context.length} chars, Message: ${message.slice(0, 100)}...`);

    try {
      const response = await requestUrl({
        url: API_URLS.groq,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.groqApiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });

      console.log(`[Groq] Response received, status: ${response.status}`);
      return response.json.choices[0].message.content;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("[Groq] Error:", errMsg);
      throw new Error(`Groq error: ${errMsg}`);
    }
  }

  async chatStream(
    message: string,
    sources: Source[],
    history: Message[],
    onChunk: (chunk: string) => void,
    provider?: string,
    model?: string
  ): Promise<void> {
    const useProvider = provider || this.settings.defaultProvider;
    const useModel = model || this.getModelForProvider(useProvider);
    const context = buildContext(sources);

    // Get full response then simulate streaming (requestUrl doesn't support SSE)
    const response = await this.getChatResponse(message, context, history, useProvider, useModel);
    await simulateStreaming(response, onChunk);
  }

  private async getChatResponse(
    message: string,
    context: string,
    history: Message[],
    provider: string,
    model: string
  ): Promise<string> {
    const handlers: Record<string, () => Promise<string>> = {
      openai: () => this.chatOpenAI(message, context, history, model),
      gemini: () => this.chatGemini(message, context, history, model),
      anthropic: () => this.chatAnthropic(message, context, history, model),
      groq: () => this.chatGroq(message, context, history, model),
    };

    const handler = handlers[provider];
    if (!handler) {
      throw new Error(`Provider ${provider} not configured`);
    }

    return handler();
  }
}

// ============================================================================
// CHAT VIEW
// ============================================================================

class ScribeChatView extends ItemView {
  plugin: ScribePlugin;
  messages: Message[] = [];
  sources: Source[] = [];
  pendingSources: Source[] = [];
  pendingMessage = "";
  messagesEl!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  sourcePreviewEl!: HTMLElement;
  modelInfoEl!: HTMLElement;
  fullVaultMode = false;
  isPreviewMode = false;
  private component = new Component();

  constructor(leaf: WorkspaceLeaf, plugin: ScribePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SCRIBE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Scribe AI";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.component.load();
    const container = this.contentEl;
    container.empty();
    container.addClass("scribe-chat-container");

    this.createHeader(container);
    this.modelInfoEl = container.createDiv({ cls: "scribe-model-info" });
    this.updateModelInfo();

    this.messagesEl = container.createDiv({ cls: "scribe-messages" });
    if (this.messages.length === 0) this.showWelcome();

    this.sourcePreviewEl = container.createDiv({ cls: "scribe-source-preview is-hidden" });

    this.createInputArea(container);
    await Promise.resolve();
  }

  private createHeader(container: HTMLElement) {
    const header = container.createDiv({ cls: "scribe-header" });
    header.createEl("h4", { text: "Archivist AI" });

    const controls = header.createDiv({ cls: "scribe-controls" });

    const providerSelect = controls.createEl("select", { cls: "scribe-provider-select" });
    const providers = [
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
      { value: "anthropic", label: "Anthropic" },
      { value: "groq", label: "Groq" },
    ];
    providers.forEach((p) => {
      const opt = providerSelect.createEl("option", { value: p.value, text: p.label });
      if (p.value === this.plugin.settings.defaultProvider) opt.selected = true;
    });
    providerSelect.addEventListener("change", () => {
      this.plugin.settings.defaultProvider = providerSelect.value;
      void this.plugin.saveSettings();
      this.updateModelInfo();
    });

    const fullVaultLabel = controls.createEl("label", { cls: "scribe-toggle" });
    const checkbox = fullVaultLabel.createEl("input", { type: "checkbox" });
    checkbox.checked = this.fullVaultMode;
    checkbox.addEventListener("change", () => (this.fullVaultMode = checkbox.checked));
    fullVaultLabel.createSpan({ text: "Full vault" });

    const indexBtn = controls.createEl("button", { cls: "scribe-btn-small", text: "Index" });
    indexBtn.addEventListener("click", () => { void this.plugin.indexVault(); });
  }

  private createInputArea(container: HTMLElement) {
    const inputArea = container.createDiv({ cls: "scribe-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "scribe-input",
      placeholder: "Ask anything...",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.searchAndPreview();
      }
    });

    const sendBtn = inputArea.createEl("button", { cls: "scribe-send-btn", text: "Send" });
    sendBtn.addEventListener("click", () => { void this.searchAndPreview(); });
  }

  updateModelInfo() {
    const provider = this.plugin.settings.defaultProvider;
    const model = this.plugin.getModelForProvider(provider);
    this.modelInfoEl.empty();
    this.modelInfoEl.createSpan({ text: `Model: ${provider}/${model}`, cls: "scribe-model-label" });
  }

  estimateCost(sources: Source[], messageLength: number): string {
    let totalChars = messageLength + sources.reduce((sum, s) => sum + s.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);

    const costs: Record<string, number> = {
      "gpt-5.4-nano": 0.2,
      "gpt-5.4-mini": 0.75,
      "gpt-5.4": 2.5,
      "gpt-5.4-pro": 30,
      "gpt-5.2": 1.75,
      "gpt-5-nano": 0.05,
      "gpt-5-mini": 0.25,
      "gpt-5": 1.25,
      "gpt-4.1-nano": 0.1,
      "gpt-4.1-mini": 0.4,
      "gpt-4.1": 2,
      "gpt-4o": 2.5,
      "gpt-4o-mini": 0.15,
      "gemini-2.5-flash-lite": 0,
      "gemini-2.5-flash": 0,
      "gemini-2.0-flash": 0.1,
      "gemini-1.5-pro": 1.25,
      "claude-sonnet-4-20250514": 3,
      "claude-3-5-sonnet-20241022": 3,
      "claude-3-5-haiku-20241022": 0.25,
    };

    const model = this.plugin.getModelForProvider(this.plugin.settings.defaultProvider);
    const costPer1M = costs[model] || 0.5;
    const estimatedCost = (estimatedTokens / 1000000) * costPer1M;

    return `~${estimatedTokens.toLocaleString()} tokens (~$${estimatedCost.toFixed(4)})`;
  }

  showWelcome() {
    const welcome = this.messagesEl.createDiv({ cls: "scribe-welcome" });
    welcome.createEl("h3", { text: "Welcome to Archivist AI" });
    welcome.createEl("p", {
      text: "Ask questions about your vault. I'll search for relevant context and provide informed answers.",
    });

    if (this.plugin.embeddings.length === 0) {
      const notice = welcome.createDiv({ cls: "scribe-notice" });
      notice.createEl("p", { text: "Your vault hasn't been indexed yet." });
      const indexBtn = notice.createEl("button", { text: "Index now" });
      indexBtn.addEventListener("click", () => {
        void this.plugin.indexVault();
        notice.remove();
      });
    } else {
      welcome.createEl("p", {
        text: `${this.plugin.embeddings.length} chunks indexed`,
        cls: "scribe-stats",
      });
    }
  }

  async searchAndPreview() {
    const message = this.inputEl.value.trim();
    if (!message) return;

    this.pendingMessage = message;
    this.sourcePreviewEl.removeClass("is-hidden");
    this.sourcePreviewEl.empty();

    const searchingEl = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-searching" });
    searchingEl.createDiv({ cls: "scribe-searching-icon" });
    searchingEl.createDiv({ cls: "scribe-preview-searching-text", text: "Searching for relevant sources..." });

    // Get vault sources
    this.pendingSources = this.fullVaultMode
      ? await this.plugin.getFullVaultContent()
      : await this.plugin.search(message, this.plugin.settings.contextSize);

    // Extract and fetch any URLs in the message
    const urls = extractUrls(message);
    if (urls.length > 0) {
      searchingEl.querySelector(".scribe-preview-searching-text")?.setText(`Fetching ${urls.length} web page(s)...`);

      for (const url of urls) {
        const webContent = await fetchWebPage(url);
        if (webContent) {
          this.pendingSources.unshift({
            path: url,
            content: webContent.content,
            score: 100,
            header: webContent.title,
          });
        }
      }
    }

    this.isPreviewMode = true;
    this.renderSourcePreview();
  }

  renderSourcePreview() {
    this.sourcePreviewEl.empty();

    const header = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-header" });
    header.createEl("h4", { text: `Sources found: ${this.pendingSources.length}` });
    header.createSpan({ text: this.estimateCost(this.pendingSources, this.pendingMessage.length), cls: "scribe-cost-estimate" });

    const sourceList = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-sources" });

    this.pendingSources.forEach((source, i) => {
      const item = sourceList.createDiv({ cls: "scribe-preview-source-item" });

      const info = item.createDiv({ cls: "scribe-preview-source-info" });
      info.createSpan({ text: getFileName(source.path), cls: "scribe-preview-source-name" });
      if (source.header) {
        info.createSpan({ text: ` > ${source.header}`, cls: "scribe-preview-source-header" });
      }
      info.createSpan({ text: ` (${source.score}%)`, cls: "scribe-preview-source-score" });

      const removeBtn = item.createEl("button", { text: "\u00d7", cls: "scribe-preview-remove-btn" });
      removeBtn.addEventListener("click", () => {
        this.pendingSources.splice(i, 1);
        this.renderSourcePreview();
      });
    });

    this.createSourcePreviewActions();
  }

  private createSourcePreviewActions() {
    const addSection = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-add-section" });

    const clearAllBtn = addSection.createEl("button", { text: "Clear all sources", cls: "scribe-btn-small scribe-btn-warning" });
    clearAllBtn.addEventListener("click", () => {
      this.pendingSources = [];
      this.renderSourcePreview();
    });

    const getMoreBtn = addSection.createEl("button", { text: "Get more sources", cls: "scribe-btn-small" });
    getMoreBtn.addEventListener("click", () => {
      void (async () => {
        const moreSources = await this.plugin.search(this.pendingMessage, this.plugin.settings.contextSize * 2);
        for (const source of moreSources) {
          if (!this.pendingSources.find((s) => s.path === source.path && s.header === source.header)) {
            this.pendingSources.push(source);
          }
        }
        this.renderSourcePreview();
      })();
    });

    const addRow = addSection.createDiv({ cls: "scribe-preview-add-row" });
    const fileInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Add file manually (e.g., Notes/myfile.md)",
      cls: "scribe-preview-add-input",
    });
    const addBtn = addRow.createEl("button", { text: "Add", cls: "scribe-btn-small" });
    addBtn.addEventListener("click", () => {
      void (async () => {
        const filePath = fileInput.value.trim();
        if (!filePath) return;

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file);
          this.pendingSources.push({ path: filePath, content: content.slice(0, 2000), score: 100, header: "Manual" });
          fileInput.value = "";
          this.renderSourcePreview();
        } else {
          new Notice("File not found: " + filePath);
        }
      })();
    });

    // URL input row
    const urlRow = addSection.createDiv({ cls: "scribe-preview-add-row" });
    const urlInput = urlRow.createEl("input", {
      type: "text",
      placeholder: "Add URL (e.g., https://example.com/page)",
      cls: "scribe-preview-add-input",
    });
    const addUrlBtn = urlRow.createEl("button", { text: "Fetch", cls: "scribe-btn-small" });
    addUrlBtn.addEventListener("click", () => {
      void (async () => {
        const url = urlInput.value.trim();
        if (!url) return;

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          new Notice("Please enter a valid URL starting with http:// or https://");
          return;
        }

        addUrlBtn.setText("Fetching...");
        addUrlBtn.disabled = true;

        const webContent = await fetchWebPage(url);
        if (webContent) {
          this.pendingSources.unshift({
            path: url,
            content: webContent.content,
            score: 100,
            header: webContent.title,
          });
          urlInput.value = "";
          this.renderSourcePreview();
        } else {
          new Notice("Failed to fetch URL: " + url);
          addUrlBtn.setText("Fetch");
          addUrlBtn.disabled = false;
        }
      })();
    });

    // Local file upload row
    const uploadRow = addSection.createDiv({ cls: "scribe-preview-add-row" });
    const fileUploadInput = uploadRow.createEl("input", {
      type: "file",
      attr: { accept: ".txt,.md,.json,.csv,.html,.xml,.js,.ts,.py,.java,.c,.cpp,.css" },
      cls: "scribe-file-upload-input is-hidden",
    });

    const uploadLabel = uploadRow.createEl("span", {
      text: "Upload file from computer",
      cls: "scribe-preview-add-input scribe-upload-label",
    });
    const uploadBtn = uploadRow.createEl("button", { text: "Browse", cls: "scribe-btn-small" });
    uploadBtn.addEventListener("click", () => fileUploadInput.click());

    fileUploadInput.addEventListener("change", () => {
      const file = fileUploadInput.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        if (content) {
          this.pendingSources.push({
            path: `[Upload] ${file.name}`,
            content: content.slice(0, 5000),
            score: 100,
            header: "Uploaded file",
          });
          uploadLabel.setText(`Uploaded: ${file.name}`);
          this.renderSourcePreview();
        }
      };
      reader.onerror = () => {
        new Notice("Failed to read file: " + file.name);
      };
      reader.readAsText(file);
    });

    const actions = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-actions" });

    const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "scribe-btn-small" });
    cancelBtn.addEventListener("click", () => {
      this.isPreviewMode = false;
      this.sourcePreviewEl.addClass("is-hidden");
      this.pendingSources = [];
      this.pendingMessage = "";
    });

    const confirmBtn = actions.createEl("button", {
      text: this.pendingSources.length > 0 ? "Send with sources" : "Send without sources",
      cls: "scribe-send-btn"
    });
    confirmBtn.addEventListener("click", () => { void this.confirmAndSend(); });
  }

  async confirmAndSend() {
    if (!this.pendingMessage) return;

    this.isPreviewMode = false;
    this.sourcePreviewEl.addClass("is-hidden");

    const message = this.pendingMessage;
    this.sources = [...this.pendingSources];
    this.inputEl.value = "";
    this.pendingMessage = "";
    this.pendingSources = [];

    this.messagesEl.querySelector(".scribe-welcome")?.remove();
    this.addMessage("user", message);
    this.messages.push({ role: "user", content: message });

    const responseEl = this.createThinkingMessage();

    try {
      let fullResponse = "";
      let hasStarted = false;

      await this.plugin.chatStream(message, this.sources, this.messages.slice(0, -1), (chunk: string) => {
        if (!hasStarted) {
          hasStarted = true;
          responseEl.removeClass("thinking");
        }
        fullResponse += chunk;
        const streamingEl = responseEl.querySelector(".scribe-streaming-content") as HTMLElement;
        streamingEl.empty();
        void MarkdownRenderer.render(this.app, fullResponse, streamingEl, "", this.component);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      });

      this.addResponseExtras(responseEl, fullResponse);
      this.messages.push({ role: "assistant", content: fullResponse });
    } catch (e: unknown) {
      const streamingEl = responseEl.querySelector(".scribe-streaming-content") as HTMLElement;
      streamingEl.setText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private createThinkingMessage(): HTMLElement {
    const responseEl = this.messagesEl.createDiv({ cls: "scribe-message assistant thinking" });
    const avatar = responseEl.createDiv({ cls: "scribe-avatar" });
    avatar.setText("S");

    const contentEl = responseEl.createDiv({ cls: "scribe-content" });
    const streamingEl = contentEl.createDiv({ cls: "scribe-streaming-content" });

    const loadingEl = streamingEl.createDiv({ cls: "scribe-loading" });
    loadingEl.createSpan({ cls: "scribe-thinking-spinner" });
    loadingEl.createSpan({ text: "Thinking", cls: "scribe-loading-text" });

    const dotsEl = loadingEl.createDiv({ cls: "scribe-loading-dots" });
    for (let i = 0; i < 3; i++) {
      dotsEl.createDiv({ cls: "scribe-loading-dot" });
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return responseEl;
  }

  private addResponseExtras(responseEl: HTMLElement, fullResponse: string) {
    const contentEl = responseEl.querySelector(".scribe-content") as HTMLElement;

    if (this.sources.length > 0 && this.plugin.settings.showSources) {
      this.createSourceBadges(contentEl, this.sources);
    }

    this.createActionButtons(contentEl, fullResponse);
  }

  private createSourceBadges(container: HTMLElement, sources: Source[]) {
    const sourcesEl = container.createDiv({ cls: "scribe-sources" });
    sourcesEl.createEl("span", { text: "Sources: ", cls: "scribe-sources-label" });

    for (const source of sources.slice(0, 5)) {
      const badge = sourcesEl.createEl("span", { cls: "scribe-source-badge" });
      badge.setText(getFileName(source.path));
      badge.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(source.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });
    }
  }

  private createActionButtons(container: HTMLElement, content: string) {
    const actionsEl = container.createDiv({ cls: "scribe-actions" });

    const copyBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Copy" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    const todoBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Save as todo" });
    todoBtn.addEventListener("click", () => this.saveAsTodo(content));
  }

  addMessage(role: "user" | "assistant", content: string, sources?: Source[]) {
    const messageEl = this.messagesEl.createDiv({ cls: `scribe-message ${role}` });

    const avatar = messageEl.createDiv({ cls: "scribe-avatar" });
    avatar.setText(role === "user" ? "Y" : "S");

    const contentEl = messageEl.createDiv({ cls: "scribe-content" });
    void MarkdownRenderer.render(this.app, content, contentEl, "", this.component);

    if (sources?.length && this.plugin.settings.showSources) {
      this.createSourceBadges(contentEl, sources);
    }

    const actionsEl = contentEl.createDiv({ cls: "scribe-actions" });
    const copyBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Copy" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    if (role === "assistant") {
      const todoBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Save as todo" });
      todoBtn.addEventListener("click", () => this.saveAsTodo(content));
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  saveAsTodo(content: string) {
    new TodoTitleModal(this.app, async (title: string) => {
      const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
      const filename = `TODO_${timestamp}_${title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30)}.md`;

      let todoContent = `# ${title}\n\n> Generated by Archivist AI on ${new Date().toLocaleString()}\n\n---\n\n`;

      for (const line of content.split("\n")) {
        const stripped = line.trim();
        if (stripped.startsWith("- ") && !stripped.startsWith("- [ ]")) {
          todoContent += line.replace("- ", "- [ ] ") + "\n";
        } else if (stripped.startsWith("* ") && !stripped.startsWith("* [ ]")) {
          todoContent += line.replace("* ", "- [ ] ") + "\n";
        } else if (/^\d+\.\s/.test(stripped)) {
          todoContent += "- [ ] " + stripped.replace(/^\d+\.\s*/, "") + "\n";
        } else {
          todoContent += line + "\n";
        }
      }

      const todosFolder = this.app.vault.getAbstractFileByPath("TODOs");
      const savePath = todosFolder ? `TODOs/${filename}` : filename;

      try {
        const file = await this.app.vault.create(savePath, todoContent);
        new Notice(`Saved to ${savePath}`);
        await this.app.workspace.getLeaf(false).openFile(file);
      } catch {
        new Notice("Failed to save TODO");
      }
    }).open();
  }

  async onClose(): Promise<void> {
    this.component.unload();
    await Promise.resolve();
  }
}

// ============================================================================
// CONNECTIONS VIEW
// ============================================================================

class ScribeConnectionsView extends ItemView {
  plugin: ScribePlugin;
  connectionsEl!: HTMLElement;
  currentFile: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ScribePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SCRIBE_CONNECTIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Scribe Connections";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("scribe-connections-container");

    // Header
    const header = container.createDiv({ cls: "scribe-connections-header" });
    header.createEl("h4", { text: "Connections" });

    const refreshBtn = header.createEl("button", { cls: "scribe-btn-small", text: "Refresh" });
    refreshBtn.addEventListener("click", () => this.refresh());

    // Connections list
    this.connectionsEl = container.createDiv({ cls: "scribe-connections-list" });

    // Initial render
    this.refresh();
    await Promise.resolve();
  }

  refresh() {
    const activeFile = this.app.workspace.getActiveFile();
    this.currentFile = activeFile;
    this.renderConnections();
  }

  private renderConnections() {
    this.connectionsEl.empty();

    if (!this.currentFile) {
      this.renderEmptyState("Open a note to see connections");
      return;
    }

    if (this.plugin.embeddings.length === 0) {
      this.renderEmptyState("Index your vault first to see connections", true);
      return;
    }

    // Show current file info
    const currentInfo = this.connectionsEl.createDiv({ cls: "scribe-current-file" });
    currentInfo.createEl("span", { text: "Connections for:", cls: "scribe-current-label" });
    currentInfo.createEl("span", { text: getFileName(this.currentFile.path), cls: "scribe-current-name" });

    // Find and display connections
    const connections = this.plugin.findSimilarNotes(this.currentFile.path, 15);

    if (connections.length === 0) {
      this.renderEmptyState("No similar notes found. Try indexing more files.");
      return;
    }

    // Group by relevance
    const highRelevance = connections.filter((c) => c.score >= 70);
    const mediumRelevance = connections.filter((c) => c.score >= 50 && c.score < 70);
    const lowRelevance = connections.filter((c) => c.score < 50);

    if (highRelevance.length > 0) {
      this.renderConnectionGroup("Highly related", highRelevance, "high");
    }
    if (mediumRelevance.length > 0) {
      this.renderConnectionGroup("Related", mediumRelevance, "medium");
    }
    if (lowRelevance.length > 0) {
      this.renderConnectionGroup("Somewhat related", lowRelevance, "low");
    }
  }

  private renderEmptyState(message: string, showIndexBtn = false) {
    const empty = this.connectionsEl.createDiv({ cls: "scribe-connections-empty" });
    empty.createEl("p", { text: message });

    if (showIndexBtn) {
      const indexBtn = empty.createEl("button", { text: "Index now", cls: "scribe-btn-small" });
      indexBtn.addEventListener("click", () => { void this.plugin.indexVault(); });
    }
  }

  private renderConnectionGroup(title: string, connections: Connection[], level: string) {
    const group = this.connectionsEl.createDiv({ cls: `scribe-connection-group scribe-connection-${level}` });
    group.createEl("h5", { text: `${title} (${connections.length})`, cls: "scribe-group-title" });

    const list = group.createDiv({ cls: "scribe-connection-items" });

    for (const conn of connections) {
      const item = list.createDiv({ cls: "scribe-connection-item" });

      // Score indicator
      const scoreEl = item.createDiv({ cls: "scribe-connection-score" });
      const scoreBar = scoreEl.createDiv({ cls: "scribe-score-bar" });
      scoreBar.setCssProps({ "--score-width": `${conn.score}%` });
      scoreEl.createSpan({ text: `${conn.score}%`, cls: "scribe-score-text" });

      // File info
      const infoEl = item.createDiv({ cls: "scribe-connection-info" });
      infoEl.createEl("span", { text: getFileName(conn.path), cls: "scribe-connection-name" });

      if (conn.bestHeader) {
        infoEl.createEl("span", { text: ` > ${conn.bestHeader}`, cls: "scribe-connection-header" });
      }

      if (conn.matchingChunks > 1) {
        infoEl.createEl("span", { text: ` (${conn.matchingChunks} sections)`, cls: "scribe-connection-chunks" });
      }

      // Click to open
      item.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(conn.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      // Hover preview
      item.addEventListener("mouseenter", (e) => {
        const file = this.app.vault.getAbstractFileByPath(conn.path);
        if (file instanceof TFile) {
          this.app.workspace.trigger("hover-link", {
            event: e,
            source: SCRIBE_CONNECTIONS_VIEW_TYPE,
            hoverParent: item,
            targetEl: item,
            linktext: conn.path,
          });
        }
      });
    }
  }

  async onClose(): Promise<void> {
    await Promise.resolve();
  }
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

class ScribeSettingTab extends PluginSettingTab {
  plugin: ScribePlugin;
  progressIntervalId: number | null = null;

  constructor(app: App, plugin: ScribePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.progressIntervalId !== null) {
      window.clearInterval(this.progressIntervalId);
      this.progressIntervalId = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("General").setHeading();

    this.addApiKeySettings(containerEl);
    this.addProviderSettings(containerEl);
    this.addIndexingSettings(containerEl);
    this.addChatSettings(containerEl);
    this.addActionSettings(containerEl);
  }

  private addApiKeySettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName("API keys").setHeading();

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Required for GPT models and embeddings")
      .addText((text) =>
        text.setPlaceholder("sk-...").setValue(this.plugin.settings.openaiApiKey).onChange((value) => {
          this.plugin.settings.openaiApiKey = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("For Google Gemini models (free tier available)")
      .addText((text) =>
        text.setPlaceholder("AI...").setValue(this.plugin.settings.geminiApiKey).onChange((value) => {
          this.plugin.settings.geminiApiKey = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("For Claude models")
      .addText((text) =>
        text.setPlaceholder("sk-ant-...").setValue(this.plugin.settings.anthropicApiKey).onChange((value) => {
          this.plugin.settings.anthropicApiKey = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Groq API key")
      .setDesc("For fast Groq inference (free tier available)")
      .addText((text) =>
        text.setPlaceholder("gsk_...").setValue(this.plugin.settings.groqApiKey).onChange((value) => {
          this.plugin.settings.groqApiKey = value;
          void this.plugin.saveSettings();
        })
      );
  }

  private addProviderSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Providers").setHeading();

    new Setting(containerEl)
      .setName("Default provider")
      .setDesc("Which AI provider to use by default")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai", "OpenAI (GPT)")
          .addOption("gemini", "Google Gemini")
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("groq", "Groq")
          .setValue(this.plugin.settings.defaultProvider)
          .onChange((value) => {
            this.plugin.settings.defaultProvider = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OpenAI model")
      .setDesc("Model for OpenAI provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gpt-5.4-nano", "GPT-5.4 Nano ($0.20/1M)")
          .addOption("gpt-5.4-mini", "GPT-5.4 Mini ($0.75/1M)")
          .addOption("gpt-5.4", "GPT-5.4 ($2.50/1M)")
          .addOption("gpt-5.4-pro", "GPT-5.4 Pro ($30/1M)")
          .addOption("gpt-5.2", "GPT-5.2 ($1.75/1M)")
          .addOption("gpt-5-nano", "GPT-5 Nano ($0.05/1M)")
          .addOption("gpt-5-mini", "GPT-5 Mini ($0.25/1M)")
          .addOption("gpt-5", "GPT-5 ($1.25/1M)")
          .addOption("gpt-4.1-nano", "GPT-4.1 Nano ($0.10/1M)")
          .addOption("gpt-4.1-mini", "GPT-4.1 Mini ($0.40/1M)")
          .addOption("gpt-4.1", "GPT-4.1 ($2.00/1M)")
          .addOption("gpt-4o-mini", "GPT-4o Mini ($0.15/1M)")
          .addOption("gpt-4o", "GPT-4o ($2.50/1M)")
          .addOption("o4-mini", "o4-mini (reasoning)")
          .addOption("o3-mini", "o3-mini (reasoning)")
          .addOption("o1-mini", "o1-mini (reasoning)")
          .setValue(this.plugin.settings.openaiModel)
          .onChange((value) => {
            this.plugin.settings.openaiModel = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("Model for Google Gemini provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)")
          .addOption("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite (preview)")
          .addOption("gemini-3-flash-preview", "Gemini 3 Flash (preview)")
          .addOption("gemini-2.5-pro", "Gemini 2.5 Pro")
          .addOption("gemini-2.5-flash", "Gemini 2.5 Flash (recommended)")
          .addOption("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite (free)")
          .setValue(this.plugin.settings.geminiModel)
          .onChange((value) => {
            this.plugin.settings.geminiModel = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Anthropic model")
      .setDesc("Model for Anthropic provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-sonnet-4-20250514", "Claude Sonnet 4 (recommended)")
          .addOption("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet")
          .addOption("claude-3-5-haiku-20241022", "Claude 3.5 Haiku (fast)")
          .addOption("claude-3-opus-20240229", "Claude 3 Opus")
          .addOption("claude-3-haiku-20240307", "Claude 3 Haiku (cheapest)")
          .setValue(this.plugin.settings.anthropicModel)
          .onChange((value) => {
            this.plugin.settings.anthropicModel = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Groq model")
      .setDesc("Model for Groq provider (very fast, free tier)")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("llama-3.3-70b-versatile", "Llama 3.3 70B")
          .addOption("llama-3.1-8b-instant", "Llama 3.1 8B (fastest)")
          .addOption("mixtral-8x7b-32768", "Mixtral 8x7B")
          .setValue(this.plugin.settings.groqModel)
          .onChange((value) => {
            this.plugin.settings.groqModel = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Model used for indexing and semantic search")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("text-embedding-3-small", "text-embedding-3-small ($0.02/1M)")
          .addOption("text-embedding-3-large", "text-embedding-3-large ($0.13/1M)")
          .addOption("text-embedding-ada-002", "text-embedding-ada-002 ($0.10/1M)")
          .setValue(this.plugin.settings.embeddingModel)
          .onChange((value) => {
            this.plugin.settings.embeddingModel = value;
            void this.plugin.saveSettings();
          })
      );
  }

  private addIndexingSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Indexing").setHeading();

    this.addTagInput(containerEl, "Include folders", "Only index these folders (leave empty for all)", "Folder name...", "includeFolders");
    this.addTagInput(containerEl, "Excluded files", "Don't index these files", "File name...", "excludedFiles");

    new Setting(containerEl)
      .setName("Context size")
      .setDesc("Number of chunks to include as context (1-100)")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.contextSize))
          .onChange((value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1 && num <= 100) {
              this.plugin.settings.contextSize = num;
              void this.plugin.saveSettings();
            }
          })
      );
  }

  private addTagInput(containerEl: HTMLElement, name: string, desc: string, placeholder: string, settingsKey: "includeFolders" | "excludedFiles") {
    new Setting(containerEl).setName(name).setDesc(desc);

    const container = containerEl.createDiv({ cls: "scribe-tags-container" });
    const inputRow = container.createEl("div", { cls: "scribe-tags-input-row" });
    const input = inputRow.createEl("input", { type: "text", placeholder, cls: "scribe-tags-input" });
    const addBtn = inputRow.createEl("button", { text: "Add", cls: "scribe-tags-add-btn" });
    const tagsList = container.createDiv({ cls: "scribe-tags-list" });

    const renderTags = () => {
      tagsList.empty();
      for (const item of this.plugin.settings[settingsKey]) {
        const tag = tagsList.createEl("span", { cls: "scribe-tag" });
        tag.createSpan({ text: item });
        const removeBtn = tag.createEl("span", { text: " \u00d7", cls: "scribe-tag-remove" });
        removeBtn.addEventListener("click", () => {
          void (async () => {
            this.plugin.settings[settingsKey] = this.plugin.settings[settingsKey].filter((f) => f !== item);
            await this.plugin.saveSettings();
            renderTags();
          })();
        });
      }
    };

    const addItem = async () => {
      const value = input.value.trim();
      if (value && !this.plugin.settings[settingsKey].includes(value)) {
        this.plugin.settings[settingsKey].push(value);
        await this.plugin.saveSettings();
        input.value = "";
        renderTags();
      }
    };

    addBtn.addEventListener("click", () => { void addItem(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void addItem();
      }
    });

    renderTags();
  }

  private addChatSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Chat").setHeading();

    new Setting(containerEl)
      .setName("Show sources")
      .setDesc("Display source references in chat responses")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSources).onChange((value) => {
          this.plugin.settings.showSources = value;
          void this.plugin.saveSettings();
        })
      );
  }

  private addActionSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName("Actions").setHeading();

    new Setting(containerEl)
      .setName("Index vault")
      .setDesc(`Currently indexed: ${this.plugin.embeddings.length} chunks`)
      .addButton((btn) => btn.setButtonText("Re-index now").onClick(() => { void this.plugin.indexVault(); }))
      .addButton((btn) => btn.setButtonText("Cancel").setWarning().onClick(() => this.plugin.cancelIndexing()));

    const progressContainer = containerEl.createDiv({ cls: "scribe-progress-container is-hidden" });
    const progressBar = progressContainer.createDiv({ cls: "scribe-progress-bar" });
    const progressFill = progressBar.createDiv({ cls: "scribe-progress-fill" });
    const progressText = progressContainer.createDiv({ cls: "scribe-progress-text" });

    const updateProgress = () => {
      if (this.plugin.indexing) {
        progressContainer.removeClass("is-hidden");
        const percent = this.plugin.indexingProgress.total > 0 ? (this.plugin.indexingProgress.current / this.plugin.indexingProgress.total) * 100 : 0;
        progressFill.setCssProps({ "--progress-width": `${percent}%` });
        progressText.setText(this.plugin.indexingStatus);
      } else if (this.plugin.indexingStatus) {
        progressContainer.removeClass("is-hidden");
        progressFill.setCssProps({ "--progress-width": "100%" });
        progressText.setText(this.plugin.indexingStatus);
      } else {
        progressContainer.addClass("is-hidden");
      }
    };

    updateProgress();

    if (this.progressIntervalId !== null) {
      window.clearInterval(this.progressIntervalId);
    }
    this.progressIntervalId = window.setInterval(updateProgress, 200);
  }
}

// ============================================================================
// SEMANTIC SEARCH VIEW
// ============================================================================

class ScribeSearchView extends ItemView {
  plugin: ScribePlugin;
  searchInput!: HTMLInputElement;
  resultsEl!: HTMLElement;
  results: SearchResult[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: ScribePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SCRIBE_SEARCH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Semantic Search";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("scribe-search-container");

    // Header
    const header = container.createDiv({ cls: "scribe-search-header" });
    header.createEl("h4", { text: "Semantic search" });

    // Search input
    const searchRow = container.createDiv({ cls: "scribe-search-row" });
    this.searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Search by meaning...",
      cls: "scribe-search-input",
    });

    const searchBtn = searchRow.createEl("button", { text: "Search", cls: "scribe-send-btn" });

    this.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { void this.performSearch(); }
    });
    searchBtn.addEventListener("click", () => { void this.performSearch(); });

    // Results
    this.resultsEl = container.createDiv({ cls: "scribe-search-results" });
    this.showEmptyState();
    await Promise.resolve();
  }

  private showEmptyState() {
    this.resultsEl.empty();
    const empty = this.resultsEl.createDiv({ cls: "scribe-search-empty" });
    empty.createEl("p", { text: "Search for notes by meaning, not just keywords." });
    empty.createEl("p", { text: `${this.plugin.embeddings.length} chunks indexed`, cls: "scribe-stats" });
  }

  async performSearch() {
    const query = this.searchInput.value.trim();
    if (!query) return;

    if (this.plugin.embeddings.length === 0) {
      new Notice("Index your vault first");
      return;
    }

    this.resultsEl.empty();
    const searching = this.resultsEl.createDiv({ cls: "scribe-preview-searching" });
    searching.createDiv({ cls: "scribe-searching-icon" });
    searching.createDiv({ cls: "scribe-preview-searching-text", text: "Searching..." });

    this.results = await this.plugin.search(query, 20);

    this.renderResults();
  }

  private renderResults() {
    this.resultsEl.empty();

    if (this.results.length === 0) {
      this.resultsEl.createEl("p", { text: "No results found", cls: "scribe-search-empty" });
      return;
    }

    const header = this.resultsEl.createDiv({ cls: "scribe-search-results-header" });
    header.createEl("span", { text: `Found ${this.results.length} results` });

    for (const result of this.results) {
      const item = this.resultsEl.createDiv({ cls: "scribe-search-result-item" });

      const scoreEl = item.createDiv({ cls: "scribe-search-score" });
      scoreEl.setText(`${result.score}%`);

      const infoEl = item.createDiv({ cls: "scribe-search-info" });
      infoEl.createEl("div", { text: getFileName(result.path), cls: "scribe-search-name" });

      if (result.header) {
        infoEl.createEl("div", { text: result.header, cls: "scribe-search-section" });
      }

      const preview = result.content.slice(0, 150).replace(/\n/g, " ") + "...";
      infoEl.createEl("div", { text: preview, cls: "scribe-search-preview" });

      item.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });
    }
  }

  async onClose(): Promise<void> {
    await Promise.resolve();
  }
}

// ============================================================================
// MODALS
// ============================================================================

class ScribeResultModal extends Modal {
  content: string;
  title: string;
  private component = new Component();

  constructor(app: App, content: string, title: string) {
    super(app);
    this.content = content;
    this.title = title;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");
    this.component.load();

    contentEl.createEl("h2", { text: this.title });

    const resultEl = contentEl.createDiv({ cls: "scribe-modal-content" });
    void MarkdownRenderer.render(this.app, this.content, resultEl, "", this.component);

    const actions = contentEl.createDiv({ cls: "scribe-modal-actions" });

    const copyBtn = actions.createEl("button", { text: "Copy", cls: "scribe-btn-small" });
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    const closeBtn = actions.createEl("button", { text: "Close", cls: "scribe-btn-small" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.component.unload();
    this.contentEl.empty();
  }
}

class BacklinkSuggestionsModal extends Modal {
  connections: Connection[];
  activeFile: TFile;

  constructor(app: App, connections: Connection[], activeFile: TFile) {
    super(app);
    this.connections = connections;
    this.activeFile = activeFile;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");

    contentEl.createEl("h2", { text: "Suggested backlinks" });
    contentEl.createEl("p", { text: `Notes that might be relevant to link from "${getFileName(this.activeFile.path)}"`, cls: "scribe-modal-desc" });

    const list = contentEl.createDiv({ cls: "scribe-suggestions-list" });

    for (const conn of this.connections) {
      const item = list.createDiv({ cls: "scribe-suggestion-item" });

      const info = item.createDiv({ cls: "scribe-suggestion-info" });
      info.createEl("span", { text: getFileName(conn.path), cls: "scribe-suggestion-name" });
      info.createEl("span", { text: ` (${conn.score}% similar)`, cls: "scribe-suggestion-score" });

      const addBtn = item.createEl("button", { text: "Add link", cls: "scribe-btn-small" });
      addBtn.addEventListener("click", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          const link = `[[${getFileName(conn.path)}]]`;
          view.editor.replaceSelection(link);
          new Notice(`Added link to ${getFileName(conn.path)}`);
          addBtn.setText("Added!");
          addBtn.disabled = true;
        }
      });

      const openBtn = item.createEl("button", { text: "Open", cls: "scribe-btn-small" });
      openBtn.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(conn.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });
    }

    const closeBtn = contentEl.createEl("button", { text: "Close", cls: "scribe-modal-close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DuplicatesModal extends Modal {
  duplicates: Array<{ path1: string; path2: string; score: number }>;

  constructor(app: App, duplicates: Array<{ path1: string; path2: string; score: number }>) {
    super(app);
    this.duplicates = duplicates;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");

    contentEl.createEl("h2", { text: "Similar/duplicate notes" });
    contentEl.createEl("p", { text: `Found ${this.duplicates.length} pairs of very similar notes (>85% similarity)`, cls: "scribe-modal-desc" });

    const list = contentEl.createDiv({ cls: "scribe-duplicates-list" });

    for (const dup of this.duplicates.slice(0, 20)) {
      const item = list.createDiv({ cls: "scribe-duplicate-item" });

      item.createEl("div", { text: `${dup.score}% similar`, cls: "scribe-duplicate-score" });

      const files = item.createDiv({ cls: "scribe-duplicate-files" });

      const file1 = files.createEl("span", { text: getFileName(dup.path1), cls: "scribe-duplicate-name" });
      file1.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(dup.path1);
        if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
      });

      files.createEl("span", { text: " ↔ " });

      const file2 = files.createEl("span", { text: getFileName(dup.path2), cls: "scribe-duplicate-name" });
      file2.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(dup.path2);
        if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
      });
    }

    const closeBtn = contentEl.createEl("button", { text: "Close", cls: "scribe-modal-close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class OrphansModal extends Modal {
  orphans: Array<{ path: string; maxScore: number }>;

  constructor(app: App, orphans: Array<{ path: string; maxScore: number }>) {
    super(app);
    this.orphans = orphans;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");

    contentEl.createEl("h2", { text: "Orphan notes" });
    contentEl.createEl("p", { text: `Found ${this.orphans.length} notes with weak connections (<40% max similarity)`, cls: "scribe-modal-desc" });

    const list = contentEl.createDiv({ cls: "scribe-orphans-list" });

    for (const orphan of this.orphans.slice(0, 30)) {
      const item = list.createDiv({ cls: "scribe-orphan-item" });

      const name = item.createEl("span", { text: getFileName(orphan.path), cls: "scribe-orphan-name" });
      name.addEventListener("click", () => {
        const file = this.app.vault.getAbstractFileByPath(orphan.path);
        if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
      });

      item.createEl("span", { text: ` (max ${orphan.maxScore}% similar)`, cls: "scribe-orphan-score" });
    }

    const closeBtn = contentEl.createEl("button", { text: "Close", cls: "scribe-modal-close" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GenerateNoteModal extends Modal {
  plugin: ScribePlugin;

  constructor(app: App, plugin: ScribePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");

    contentEl.createEl("h2", { text: "Generate note from topic" });

    const form = contentEl.createDiv({ cls: "scribe-generate-form" });

    form.createEl("label", { text: "Topic:" });
    const topicInput = form.createEl("input", { type: "text", placeholder: "Enter a topic...", cls: "scribe-modal-input" });

    form.createEl("label", { text: "Folder (optional):" });
    const folderInput = form.createEl("input", { type: "text", placeholder: "e.g., Notes/Research", cls: "scribe-modal-input" });

    const actions = contentEl.createDiv({ cls: "scribe-modal-actions" });

    const generateBtn = actions.createEl("button", { text: "Generate", cls: "scribe-send-btn" });
    generateBtn.addEventListener("click", () => {
      void (async () => {
        const topic = topicInput.value.trim();
        if (!topic) {
          new Notice("Enter a topic");
          return;
        }

        this.close();
        const file = await this.plugin.generateNoteFromTopic(topic, folderInput.value.trim() || undefined);
        if (file) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      })();
    });

    const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "scribe-btn-small" });
    cancelBtn.addEventListener("click", () => this.close());

    topicInput.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class FlashcardsModal extends Modal {
  flashcards: Flashcard[];
  plugin: ScribePlugin;
  currentIndex = 0;
  showingAnswer = false;

  constructor(app: App, flashcards: Flashcard[], plugin: ScribePlugin) {
    super(app);
    this.flashcards = flashcards;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal scribe-flashcards-modal");

    contentEl.createEl("h2", { text: `Flashcards (${this.flashcards.length})` });

    this.renderCard(contentEl);
  }

  renderCard(contentEl: HTMLElement) {
    const existing = contentEl.querySelector(".scribe-flashcard-container");
    if (existing) existing.remove();

    const container = contentEl.createDiv({ cls: "scribe-flashcard-container" });

    const progress = container.createDiv({ cls: "scribe-flashcard-progress" });
    progress.setText(`${this.currentIndex + 1} / ${this.flashcards.length}`);

    const card = this.flashcards[this.currentIndex];
    const cardEl = container.createDiv({ cls: "scribe-flashcard" });

    if (this.showingAnswer) {
      cardEl.createEl("div", { text: "Answer:", cls: "scribe-flashcard-label" });
      cardEl.createEl("div", { text: card.answer, cls: "scribe-flashcard-text" });
    } else {
      cardEl.createEl("div", { text: "Question:", cls: "scribe-flashcard-label" });
      cardEl.createEl("div", { text: card.question, cls: "scribe-flashcard-text" });
    }

    const actions = container.createDiv({ cls: "scribe-flashcard-actions" });

    if (!this.showingAnswer) {
      const showBtn = actions.createEl("button", { text: "Show answer", cls: "scribe-send-btn" });
      showBtn.addEventListener("click", () => {
        this.showingAnswer = true;
        this.renderCard(contentEl);
      });
    } else {
      const nextBtn = actions.createEl("button", { text: this.currentIndex < this.flashcards.length - 1 ? "Next" : "Finish", cls: "scribe-send-btn" });
      nextBtn.addEventListener("click", () => {
        if (this.currentIndex < this.flashcards.length - 1) {
          this.currentIndex++;
          this.showingAnswer = false;
          this.renderCard(contentEl);
        } else {
          this.close();
        }
      });

      if (this.currentIndex > 0) {
        const prevBtn = actions.createEl("button", { text: "Previous", cls: "scribe-btn-small" });
        prevBtn.addEventListener("click", () => {
          this.currentIndex--;
          this.showingAnswer = false;
          this.renderCard(contentEl);
        });
      }
    }

    const exportBtn = actions.createEl("button", { text: "Export all", cls: "scribe-btn-small" });
    exportBtn.addEventListener("click", () => { void this.exportFlashcards(); });
  }

  async exportFlashcards() {
    let content = "# Flashcards\n\n";
    for (const card of this.flashcards) {
      content += `## Q: ${card.question}\n\n${card.answer}\n\n---\n\n`;
    }

    const fileName = `Flashcards_${new Date().toISOString().slice(0, 10)}.md`;
    const file = await this.app.vault.create(fileName, content);
    new Notice(`Exported to ${fileName}`);
    this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

class OutlineModal extends Modal {
  plugin: ScribePlugin;
  private component = new Component();

  constructor(app: App, plugin: ScribePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");
    this.component.load();

    contentEl.createEl("h2", { text: "Generate outline" });

    const form = contentEl.createDiv({ cls: "scribe-generate-form" });

    form.createEl("label", { text: "Topic:" });
    const topicInput = form.createEl("input", { type: "text", placeholder: "Enter a topic...", cls: "scribe-modal-input" });

    const resultEl = contentEl.createDiv({ cls: "scribe-modal-result" });

    const actions = contentEl.createDiv({ cls: "scribe-modal-actions" });

    const generateBtn = actions.createEl("button", { text: "Generate", cls: "scribe-send-btn" });
    generateBtn.addEventListener("click", () => {
      void (async () => {
        const topic = topicInput.value.trim();
        if (!topic) {
          new Notice("Enter a topic");
          return;
        }

        generateBtn.disabled = true;
        generateBtn.setText("Generating...");

        try {
          const outline = await this.plugin.generateOutline(topic);
          resultEl.empty();
          void MarkdownRenderer.render(this.app, outline, resultEl, "", this.component);

          // Add copy button
          const copyBtn = resultEl.createEl("button", { text: "Copy outline", cls: "scribe-btn-small" });
          copyBtn.addEventListener("click", () => {
            void navigator.clipboard.writeText(outline);
            copyBtn.setText("Copied!");
          });
        } catch (e) {
          new Notice(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        generateBtn.disabled = false;
        generateBtn.setText("Generate");
      })();
    });

    const cancelBtn = actions.createEl("button", { text: "Close", cls: "scribe-btn-small" });
    cancelBtn.addEventListener("click", () => this.close());

    topicInput.focus();
  }

  onClose() {
    this.component.unload();
    this.contentEl.empty();
  }
}

class TodoTitleModal extends Modal {
  onSubmit: (title: string) => void;

  constructor(app: App, onSubmit: (title: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scribe-modal");

    contentEl.createEl("h2", { text: "Save as todo" });

    const form = contentEl.createDiv({ cls: "scribe-generate-form" });
    form.createEl("label", { text: "Title:" });
    const titleInput = form.createEl("input", {
      type: "text",
      placeholder: "Review tasks",
      cls: "scribe-modal-input",
    });
    titleInput.value = "Review tasks";

    const actions = contentEl.createDiv({ cls: "scribe-modal-actions" });

    const saveBtn = actions.createEl("button", { text: "Save", cls: "scribe-send-btn" });
    saveBtn.addEventListener("click", () => {
      const title = titleInput.value.trim();
      if (title) {
        this.close();
        this.onSubmit(title);
      }
    });

    const cancelBtnModal = actions.createEl("button", { text: "Cancel", cls: "scribe-btn-small" });
    cancelBtnModal.addEventListener("click", () => this.close());

    titleInput.focus();
    titleInput.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}
