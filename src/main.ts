import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  ItemView,
  MarkdownRenderer,
  TFile,
  Notice,
  requestUrl,
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

// ============================================================================
// CONSTANTS
// ============================================================================

const SCRIBE_VIEW_TYPE = "scribe-chat-view";
const SCRIBE_CONNECTIONS_VIEW_TYPE = "scribe-connections-view";

const API_URLS = {
  openai: "https://api.openai.com/v1/chat/completions",
  openaiEmbeddings: "https://api.openai.com/v1/embeddings",
  anthropic: "https://api.anthropic.com/v1/messages",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  gemini: (model: string, key: string) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
} as const;

const SYSTEM_PROMPT = `You are Scribe, an intelligent AI assistant with access to the user's notes vault.

Your role is to:
1. Answer questions using the provided context from the vault
2. Help organize and expand upon existing content
3. Generate new content that maintains consistency with existing materials
4. Assist with writing, editing, and brainstorming

Always base your responses on the context provided when available.
Be concise and helpful.`;

const DEFAULT_SETTINGS: ScribeSettings = {
  openaiApiKey: "",
  geminiApiKey: "",
  anthropicApiKey: "",
  groqApiKey: "",
  ollamaBaseUrl: "http://localhost:11434",
  defaultProvider: "openai",
  openaiModel: "gpt-5-nano",
  anthropicModel: "claude-3-5-haiku-20241022",
  groqModel: "llama-3.3-70b-versatile",
  geminiModel: "gemini-2.0-flash",
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

  let context = "## Relevant context from your vault:\n\n";
  for (const source of sources) {
    context += `### From: ${source.path}`;
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

  async onload() {
    await this.loadSettings();

    // Register views
    this.registerView(SCRIBE_VIEW_TYPE, (leaf) => new ScribeChatView(leaf, this));
    this.registerView(SCRIBE_CONNECTIONS_VIEW_TYPE, (leaf) => new ScribeConnectionsView(leaf, this));

    // Ribbon icons
    this.addRibbonIcon("message-square", "Open Scribe AI Chat", () => this.activateView());
    this.addRibbonIcon("git-branch", "Open Scribe Connections", () => this.activateConnectionsView());

    // Commands
    this.addCommand({
      id: "open-scribe-chat",
      name: "Open Scribe AI Chat",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "open-scribe-connections",
      name: "Open Scribe Connections",
      callback: () => this.activateConnectionsView(),
    });

    this.addCommand({
      id: "index-vault",
      name: "Index vault for RAG",
      callback: () => this.indexVault(),
    });

    this.addSettingTab(new ScribeSettingTab(this.app, this));
    await this.loadEmbeddings();

    // Update connections view when active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateConnectionsView();
      })
    );

    // Auto-index on file changes
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileForIndexing(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.queueFileForIndexing(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.removeFileFromIndex(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.removeFileFromIndex(oldPath);
          this.queueFileForIndexing(file.path);
        }
      })
    );
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
    return `${this.app.vault.configDir}/plugins/obsidian-scribe/embeddings.json`;
  }

  async loadEmbeddings() {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.embeddingsCachePath)) {
        const data = await adapter.read(this.embeddingsCachePath);
        this.embeddings = JSON.parse(data);
        console.log(`Loaded ${this.embeddings.length} embeddings from cache`);
      }
    } catch {
      console.log("No embedding cache found, will index on first use");
    }
  }

  async saveEmbeddings() {
    try {
      await this.app.vault.adapter.write(this.embeddingsCachePath, JSON.stringify(this.embeddings));
    } catch (e) {
      console.error("Failed to save embeddings cache:", e);
    }
  }

  private debouncedSaveEmbeddings() {
    if (this.saveDebounceTimer) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveEmbeddings();
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
      this.processIndexQueue();
      this.indexDebounceTimer = null;
    }, 2000); // Wait 2 seconds after last change
  }

  private async processIndexQueue() {
    if (this.pendingIndexQueue.size === 0) return;
    if (this.indexing) {
      // If full indexing is running, wait and try again
      setTimeout(() => this.processIndexQueue(), 5000);
      return;
    }

    const filesToIndex = Array.from(this.pendingIndexQueue);
    this.pendingIndexQueue.clear();

    console.log(`Auto-indexing ${filesToIndex.length} file(s)...`);

    for (const filePath of filesToIndex) {
      await this.indexSingleFile(filePath);
    }

    this.debouncedSaveEmbeddings();
    this.updateConnectionsView();
  }

  async indexSingleFile(filePath: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return false;

    try {
      // Remove existing embeddings for this file
      this.embeddings = this.embeddings.filter((e) => e.path !== filePath);

      // Read and chunk the file
      const content = await this.app.vault.read(file);
      const chunks = this.chunkText(content);

      if (chunks.length === 0) return false;

      // Create embeddings for each chunk
      for (const chunk of chunks) {
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

      console.log(`Indexed ${filePath}: ${chunks.length} chunks`);
      return true;
    } catch (e) {
      console.error(`Failed to index ${filePath}:`, e);
      return false;
    }
  }

  removeFileFromIndex(filePath: string) {
    const before = this.embeddings.length;
    this.embeddings = this.embeddings.filter((e) => e.path !== filePath);
    const removed = before - this.embeddings.length;

    if (removed > 0) {
      console.log(`Removed ${removed} embeddings for ${filePath}`);
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
      } catch (e) {
        console.error(`Failed to index ${file.path}:`, e);
      }
    }

    if (this.embeddings.length > 0) {
      await this.saveEmbeddings();
    }

    this.indexing = false;
    this.indexingStatus = this.indexingCancelled
      ? `Cancelled. Saved ${this.embeddings.length} chunks.`
      : `Done! ${this.embeddings.length} chunks from ${filesToIndex.length} files`;

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
        console.error(`Embedding API error: Status ${response.status}`);
        await delay(2000);
        return null;
      }

      if (response.text?.trim().startsWith("<")) {
        console.error("Embedding API returned HTML - possible network/proxy issue");
        await delay(2000);
        return null;
      }

      await delay(100); // Rate limiting

      const data = response.json;
      return data?.data?.[0]?.embedding ?? null;
    } catch (e) {
      console.error("Embedding request failed:", e);
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
    const { includeFolders } = this.settings;
    const sources: Source[] = [];
    let totalChars = 0;
    const maxChars = 500000;

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (totalChars >= maxChars) break;

      if (includeFolders.length > 0 && !includeFolders.some((folder) => file.path.startsWith(folder))) {
        continue;
      }

      const content = await this.app.vault.read(file);
      sources.push({ path: file.path, content, score: 100 });
      totalChars += content.length;
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

    const handlers: Record<string, () => Promise<string>> = {
      openai: () => this.chatOpenAI(message, context, history, useModel),
      gemini: () => this.chatGemini(message, context, history, useModel),
      anthropic: () => this.chatAnthropic(message, context, history, useModel),
      groq: () => this.chatGroq(message, context, history, useModel),
    };

    const handler = handlers[useProvider];
    if (!handler) {
      throw new Error(`Provider ${useProvider} not configured. Please add API key in settings.`);
    }

    return handler();
  }

  private async chatOpenAI(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.openaiApiKey) throw new Error("OpenAI API key not configured");

    const messages: Message[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: API_URLS.openai,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
    });

    return response.json.choices[0].message.content;
  }

  private async chatGemini(message: string, context: string, _history: Message[], model: string): Promise<string> {
    if (!this.settings.geminiApiKey) throw new Error("Gemini API key not configured");

    const fullPrompt = `${SYSTEM_PROMPT}\n\n${context}\n\nUser: ${message}\n\nAssistant:`;

    const response = await requestUrl({
      url: API_URLS.gemini(model, this.settings.geminiApiKey),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] }),
    });

    return response.json.candidates[0].content.parts[0].text;
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

    const response = await requestUrl({
      url: API_URLS.anthropic,
      method: "POST",
      headers: {
        "x-api-key": this.settings.anthropicApiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: `${SYSTEM_PROMPT}\n\n${context}`,
        messages,
      }),
    });

    return response.json.content[0].text;
  }

  private async chatGroq(message: string, context: string, history: Message[], model: string): Promise<string> {
    if (!this.settings.groqApiKey) throw new Error("Groq API key not configured");

    const messages: Message[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${context}` },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: API_URLS.groq,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
    });

    return response.json.choices[0].message.content;
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

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass("scribe-chat-container");

    this.createHeader(container);
    this.modelInfoEl = container.createDiv({ cls: "scribe-model-info" });
    this.updateModelInfo();

    this.messagesEl = container.createDiv({ cls: "scribe-messages" });
    if (this.messages.length === 0) this.showWelcome();

    this.sourcePreviewEl = container.createDiv({ cls: "scribe-source-preview" });
    this.sourcePreviewEl.style.display = "none";

    this.createInputArea(container);
  }

  private createHeader(container: HTMLElement) {
    const header = container.createDiv({ cls: "scribe-header" });
    header.createEl("h4", { text: "Scribe AI" });

    const controls = header.createDiv({ cls: "scribe-controls" });

    const fullVaultLabel = controls.createEl("label", { cls: "scribe-toggle" });
    const checkbox = fullVaultLabel.createEl("input", { type: "checkbox" });
    checkbox.checked = this.fullVaultMode;
    checkbox.addEventListener("change", () => (this.fullVaultMode = checkbox.checked));
    fullVaultLabel.createSpan({ text: "Full vault" });

    const indexBtn = controls.createEl("button", { cls: "scribe-btn-small", text: "Index" });
    indexBtn.addEventListener("click", () => this.plugin.indexVault());
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
        this.searchAndPreview();
      }
    });

    const sendBtn = inputArea.createEl("button", { cls: "scribe-send-btn", text: "Send" });
    sendBtn.addEventListener("click", () => this.searchAndPreview());
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
      "gpt-5-nano": 0.05,
      "gpt-5-mini": 0.25,
      "gpt-4o-mini": 0.15,
    };

    const model = this.plugin.getModelForProvider(this.plugin.settings.defaultProvider);
    const costPer1M = costs[model] || 0.5;
    const estimatedCost = (estimatedTokens / 1000000) * costPer1M;

    return `~${estimatedTokens.toLocaleString()} tokens (~$${estimatedCost.toFixed(4)})`;
  }

  showWelcome() {
    const welcome = this.messagesEl.createDiv({ cls: "scribe-welcome" });
    welcome.createEl("h3", { text: "Welcome to Scribe AI" });
    welcome.createEl("p", {
      text: "Ask questions about your vault. I'll search for relevant context and provide informed answers.",
    });

    if (this.plugin.embeddings.length === 0) {
      const notice = welcome.createDiv({ cls: "scribe-notice" });
      notice.createEl("p", { text: "Your vault hasn't been indexed yet." });
      const indexBtn = notice.createEl("button", { text: "Index Now" });
      indexBtn.addEventListener("click", () => {
        this.plugin.indexVault();
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
    this.sourcePreviewEl.style.display = "block";
    this.sourcePreviewEl.empty();

    const searchingEl = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-searching" });
    searchingEl.createDiv({ cls: "scribe-searching-icon" });
    searchingEl.createDiv({ cls: "scribe-preview-searching-text", text: "Searching for relevant sources..." });

    this.pendingSources = this.fullVaultMode
      ? await this.plugin.getFullVaultContent()
      : await this.plugin.search(message, this.plugin.settings.contextSize);

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

    const getMoreBtn = addSection.createEl("button", { text: "Get More Sources", cls: "scribe-btn-small" });
    getMoreBtn.addEventListener("click", async () => {
      const moreSources = await this.plugin.search(this.pendingMessage, this.plugin.settings.contextSize * 2);
      for (const source of moreSources) {
        if (!this.pendingSources.find((s) => s.path === source.path && s.header === source.header)) {
          this.pendingSources.push(source);
        }
      }
      this.renderSourcePreview();
    });

    const addRow = addSection.createDiv({ cls: "scribe-preview-add-row" });
    const fileInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Add file manually (e.g., Notes/myfile.md)",
      cls: "scribe-preview-add-input",
    });
    const addBtn = addRow.createEl("button", { text: "Add", cls: "scribe-btn-small" });
    addBtn.addEventListener("click", async () => {
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
    });

    const actions = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-actions" });

    const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "scribe-btn-small" });
    cancelBtn.addEventListener("click", () => {
      this.isPreviewMode = false;
      this.sourcePreviewEl.style.display = "none";
      this.pendingSources = [];
      this.pendingMessage = "";
    });

    const confirmBtn = actions.createEl("button", { text: "Send with Sources", cls: "scribe-send-btn" });
    confirmBtn.addEventListener("click", () => this.confirmAndSend());
  }

  async confirmAndSend() {
    if (!this.pendingMessage) return;

    this.isPreviewMode = false;
    this.sourcePreviewEl.style.display = "none";

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
        MarkdownRenderer.render(this.app, fullResponse, streamingEl, "", this.plugin);
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
      navigator.clipboard.writeText(content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    const todoBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Save as TODO" });
    todoBtn.addEventListener("click", () => this.saveAsTodo(content));
  }

  addMessage(role: "user" | "assistant", content: string, sources?: Source[]) {
    const messageEl = this.messagesEl.createDiv({ cls: `scribe-message ${role}` });

    const avatar = messageEl.createDiv({ cls: "scribe-avatar" });
    avatar.setText(role === "user" ? "Y" : "S");

    const contentEl = messageEl.createDiv({ cls: "scribe-content" });
    MarkdownRenderer.render(this.app, content, contentEl, "", this.plugin);

    if (sources?.length && this.plugin.settings.showSources) {
      this.createSourceBadges(contentEl, sources);
    }

    const actionsEl = contentEl.createDiv({ cls: "scribe-actions" });
    const copyBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Copy" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    if (role === "assistant") {
      const todoBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Save as TODO" });
      todoBtn.addEventListener("click", () => this.saveAsTodo(content));
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async saveAsTodo(content: string) {
    const title = prompt("Enter a title for this TODO list:", "Review Tasks");
    if (!title) return;

    const timestamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
    const filename = `TODO_${timestamp}_${title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 30)}.md`;

    let todoContent = `# ${title}\n\n> Generated by Scribe AI on ${new Date().toLocaleString()}\n\n---\n\n`;

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
      this.app.workspace.getLeaf(false).openFile(file);
    } catch (e: unknown) {
      new Notice(`Failed to save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async onClose() {
    // Cleanup
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

  async onOpen() {
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
      this.renderConnectionGroup("Highly Related", highRelevance, "high");
    }
    if (mediumRelevance.length > 0) {
      this.renderConnectionGroup("Related", mediumRelevance, "medium");
    }
    if (lowRelevance.length > 0) {
      this.renderConnectionGroup("Somewhat Related", lowRelevance, "low");
    }
  }

  private renderEmptyState(message: string, showIndexBtn = false) {
    const empty = this.connectionsEl.createDiv({ cls: "scribe-connections-empty" });
    empty.createEl("p", { text: message });

    if (showIndexBtn) {
      const indexBtn = empty.createEl("button", { text: "Index Now", cls: "scribe-btn-small" });
      indexBtn.addEventListener("click", () => this.plugin.indexVault());
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
      scoreBar.style.width = `${conn.score}%`;
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

  async onClose() {
    // Cleanup
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

    containerEl.createEl("h2", { text: "Scribe AI Settings" });

    this.addApiKeySettings(containerEl);
    this.addProviderSettings(containerEl);
    this.addIndexingSettings(containerEl);
    this.addChatSettings(containerEl);
    this.addActionSettings(containerEl);
  }

  private addApiKeySettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "API Keys" });

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Required for GPT models and embeddings")
      .addText((text) =>
        text.setPlaceholder("sk-...").setValue(this.plugin.settings.openaiApiKey).onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("For Google Gemini models (free tier available)")
      .addText((text) =>
        text.setPlaceholder("AI...").setValue(this.plugin.settings.geminiApiKey).onChange(async (value) => {
          this.plugin.settings.geminiApiKey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Anthropic API Key")
      .setDesc("For Claude models")
      .addText((text) =>
        text.setPlaceholder("sk-ant-...").setValue(this.plugin.settings.anthropicApiKey).onChange(async (value) => {
          this.plugin.settings.anthropicApiKey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Groq API Key")
      .setDesc("For fast Groq inference (free tier available)")
      .addText((text) =>
        text.setPlaceholder("gsk_...").setValue(this.plugin.settings.groqApiKey).onChange(async (value) => {
          this.plugin.settings.groqApiKey = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private addProviderSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Provider Settings" });

    new Setting(containerEl)
      .setName("Default Provider")
      .setDesc("Which AI provider to use by default")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai", "OpenAI (GPT)")
          .addOption("gemini", "Google Gemini")
          .addOption("anthropic", "Anthropic (Claude)")
          .addOption("groq", "Groq")
          .setValue(this.plugin.settings.defaultProvider)
          .onChange(async (value) => {
            this.plugin.settings.defaultProvider = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OpenAI Model")
      .setDesc("Model for OpenAI provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gpt-5-nano", "GPT-5 Nano (fastest, $0.05/1M)")
          .addOption("gpt-5-mini", "GPT-5 Mini ($0.25/1M)")
          .addOption("gpt-4o-mini", "GPT-4o Mini ($0.15/1M)")
          .addOption("gpt-4o", "GPT-4o ($2.50/1M)")
          .setValue(this.plugin.settings.openaiModel)
          .onChange(async (value) => {
            this.plugin.settings.openaiModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Anthropic Model")
      .setDesc("Model for Anthropic provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("claude-3-5-haiku-20241022", "Claude 3.5 Haiku (fastest)")
          .addOption("claude-sonnet-4-20250514", "Claude Sonnet 4")
          .addOption("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet")
          .setValue(this.plugin.settings.anthropicModel)
          .onChange(async (value) => {
            this.plugin.settings.anthropicModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Groq Model")
      .setDesc("Model for Groq provider (very fast, free tier)")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("llama-3.3-70b-versatile", "Llama 3.3 70B")
          .addOption("llama-3.1-8b-instant", "Llama 3.1 8B (fastest)")
          .addOption("mixtral-8x7b-32768", "Mixtral 8x7B")
          .setValue(this.plugin.settings.groqModel)
          .onChange(async (value) => {
            this.plugin.settings.groqModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding Model")
      .setDesc("Model used for indexing and semantic search")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("text-embedding-3-small", "text-embedding-3-small ($0.02/1M)")
          .addOption("text-embedding-3-large", "text-embedding-3-large ($0.13/1M)")
          .addOption("text-embedding-ada-002", "text-embedding-ada-002 ($0.10/1M)")
          .setValue(this.plugin.settings.embeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.embeddingModel = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private addIndexingSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Indexing Settings" });

    this.addTagInput(containerEl, "Include Folders", "Only index these folders (leave empty for all)", "Folder name...", "includeFolders");
    this.addTagInput(containerEl, "Excluded Files", "Don't index these files", "File name...", "excludedFiles");

    new Setting(containerEl)
      .setName("Context Size")
      .setDesc("Number of chunks to include as context (1-100)")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.contextSize))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1 && num <= 100) {
              this.plugin.settings.contextSize = num;
              await this.plugin.saveSettings();
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
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings[settingsKey] = this.plugin.settings[settingsKey].filter((f) => f !== item);
          await this.plugin.saveSettings();
          renderTags();
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

    addBtn.addEventListener("click", addItem);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addItem();
      }
    });

    renderTags();
  }

  private addChatSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Chat Settings" });

    new Setting(containerEl)
      .setName("Show Sources")
      .setDesc("Display source references in chat responses")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSources).onChange(async (value) => {
          this.plugin.settings.showSources = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private addActionSettings(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Index Vault")
      .setDesc(`Currently indexed: ${this.plugin.embeddings.length} chunks`)
      .addButton((btn) => btn.setButtonText("Re-index Now").onClick(() => this.plugin.indexVault()))
      .addButton((btn) => btn.setButtonText("Cancel").setWarning().onClick(() => this.plugin.cancelIndexing()));

    const progressContainer = containerEl.createDiv({ cls: "scribe-progress-container" });
    const progressBar = progressContainer.createDiv({ cls: "scribe-progress-bar" });
    const progressFill = progressBar.createDiv({ cls: "scribe-progress-fill" });
    const progressText = progressContainer.createDiv({ cls: "scribe-progress-text" });

    const updateProgress = () => {
      if (this.plugin.indexing) {
        progressContainer.style.display = "block";
        const percent = this.plugin.indexingProgress.total > 0 ? (this.plugin.indexingProgress.current / this.plugin.indexingProgress.total) * 100 : 0;
        progressFill.style.width = `${percent}%`;
        progressText.setText(this.plugin.indexingStatus);
      } else if (this.plugin.indexingStatus) {
        progressContainer.style.display = "block";
        progressFill.style.width = "100%";
        progressText.setText(this.plugin.indexingStatus);
      } else {
        progressContainer.style.display = "none";
      }
    };

    updateProgress();

    if (this.progressIntervalId !== null) {
      window.clearInterval(this.progressIntervalId);
    }
    this.progressIntervalId = window.setInterval(updateProgress, 200);
  }
}
