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
  defaultModel: string;
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

// ============================================================================
// DEFAULT SETTINGS
// ============================================================================

const DEFAULT_SETTINGS: ScribeSettings = {
  openaiApiKey: "",
  geminiApiKey: "",
  anthropicApiKey: "",
  groqApiKey: "",
  ollamaBaseUrl: "http://localhost:11434",
  defaultProvider: "openai",
  defaultModel: "gpt-5.4-nano",
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  includeFolders: [],
  excludedFiles: [],
  contextSize: 10,
  showSources: true,
  confirmBeforeSend: false,
};

// ============================================================================
// VIEW TYPE
// ============================================================================

const SCRIBE_VIEW_TYPE = "scribe-chat-view";

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export default class ScribePlugin extends Plugin {
  settings: ScribeSettings;
  embeddings: EmbeddingEntry[] = [];
  indexing: boolean = false;
  indexingCancelled: boolean = false;
  indexingStatus: string = "";
  indexingProgress: { current: number; total: number } = { current: 0, total: 0 };

  async onload() {
    await this.loadSettings();

    // Register the chat view
    this.registerView(SCRIBE_VIEW_TYPE, (leaf) => new ScribeChatView(leaf, this));

    // Add ribbon icon
    this.addRibbonIcon("message-square", "Open Scribe AI", () => {
      this.activateView();
    });

    // Add command to open chat
    this.addCommand({
      id: "open-scribe-chat",
      name: "Open Scribe AI Chat",
      callback: () => {
        this.activateView();
      },
    });

    // Add command to index vault
    this.addCommand({
      id: "index-vault",
      name: "Index vault for RAG",
      callback: () => {
        this.indexVault();
      },
    });

    // Add settings tab
    this.addSettingTab(new ScribeSettingTab(this.app, this));

    // Load embeddings from cache
    await this.loadEmbeddings();
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(SCRIBE_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: SCRIBE_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

    // Migrate old string-based settings to arrays
    if (typeof this.settings.includeFolders === "string") {
      const str = this.settings.includeFolders as unknown as string;
      this.settings.includeFolders = str ? str.split(",").map(s => s.trim()).filter(s => s) : [];
    }
    if (typeof this.settings.excludedFiles === "string") {
      const str = this.settings.excludedFiles as unknown as string;
      this.settings.excludedFiles = str ? str.split(",").map(s => s.trim()).filter(s => s) : [];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ============================================================================
  // EMBEDDING & INDEXING
  // ============================================================================

  async loadEmbeddings() {
    const cacheFile = this.app.vault.configDir + "/plugins/obsidian-scribe/embeddings.json";
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(cacheFile)) {
        const data = await adapter.read(cacheFile);
        this.embeddings = JSON.parse(data);
        console.log(`Loaded ${this.embeddings.length} embeddings from cache`);
      }
    } catch (e) {
      console.log("No embedding cache found, will index on first use");
    }
  }

  async saveEmbeddings() {
    const cacheFile = this.app.vault.configDir + "/plugins/obsidian-scribe/embeddings.json";
    try {
      const adapter = this.app.vault.adapter;
      await adapter.write(cacheFile, JSON.stringify(this.embeddings));
    } catch (e) {
      console.error("Failed to save embeddings cache:", e);
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

    // Create a persistent notice that we'll update
    let currentNotice: Notice | null = new Notice("Starting indexing...", 0);

    const files = this.app.vault.getMarkdownFiles();
    const includeFolders = this.settings.includeFolders;
    const excludedFiles = this.settings.excludedFiles;

    const filesToIndex = files.filter((file) => {
      // Check include folders
      if (includeFolders.length > 0) {
        const inIncluded = includeFolders.some((folder) =>
          file.path.startsWith(folder)
        );
        if (!inIncluded) return false;
      }

      // Check excluded files
      if (excludedFiles.includes(file.name)) return false;

      return true;
    });

    this.indexingProgress.total = filesToIndex.length;
    this.embeddings = [];

    for (let i = 0; i < filesToIndex.length; i++) {
      // Check for cancellation
      if (this.indexingCancelled) {
        this.indexingStatus = `Cancelled at ${i}/${filesToIndex.length} files`;
        break;
      }

      const file = filesToIndex[i];
      try {
        // Update progress
        this.indexingProgress.current = i + 1;
        this.indexingStatus = `${i + 1}/${filesToIndex.length} - ${file.name}`;

        // Update notice
        if (currentNotice) {
          currentNotice.setMessage(`Indexing: ${this.indexingStatus}`);
        }

        const content = await this.app.vault.read(file);
        const chunks = this.chunkText(content, file.path);

        for (let j = 0; j < chunks.length; j++) {
          // Check for cancellation
          if (this.indexingCancelled) break;

          const chunk = chunks[j];

          // Update with chunk progress for files with many chunks
          if (chunks.length > 3) {
            this.indexingStatus = `${i + 1}/${filesToIndex.length} - ${file.name} (chunk ${j + 1}/${chunks.length})`;
            if (currentNotice) {
              currentNotice.setMessage(`Indexing: ${this.indexingStatus}`);
            }
          }

          const embedding = await this.createEmbedding(chunk.content);
          if (embedding) {
            this.embeddings.push({
              path: file.path,
              content: chunk.content,
              embedding: embedding,
              header: chunk.header,
            });
          }
        }
      } catch (e) {
        console.error(`Failed to index ${file.path}:`, e);
        // Continue to next file on error
      }
    }

    // Save whatever we indexed (even if cancelled)
    if (this.embeddings.length > 0) {
      await this.saveEmbeddings();
    }

    this.indexing = false;

    if (this.indexingCancelled) {
      this.indexingStatus = `Cancelled. Saved ${this.embeddings.length} chunks.`;
    } else {
      this.indexingStatus = `Done! ${this.embeddings.length} chunks from ${filesToIndex.length} files`;
    }

    // Hide progress notice and show completion
    if (currentNotice) {
      currentNotice.hide();
    }
    new Notice(this.indexingStatus, 5000);
  }

  chunkText(text: string, path: string): { content: string; header?: string }[] {
    const chunks: { content: string; header?: string }[] = [];
    const lines = text.split("\n");
    let currentChunk: string[] = [];
    let currentHeader = "";
    let currentSize = 0;
    const maxSize = 1000;

    for (const line of lines) {
      if (line.startsWith("#")) {
        if (currentChunk.length > 0 && currentSize > 50) {
          chunks.push({
            content: currentChunk.join("\n"),
            header: currentHeader,
          });
        }
        currentChunk = [line];
        currentHeader = line.replace(/^#+\s*/, "").trim();
        currentSize = line.length;
      } else {
        currentChunk.push(line);
        currentSize += line.length;

        if (currentSize > maxSize) {
          chunks.push({
            content: currentChunk.join("\n"),
            header: currentHeader,
          });
          currentChunk = [];
          currentSize = 0;
        }
      }
    }

    if (currentChunk.length > 0 && currentSize > 50) {
      chunks.push({
        content: currentChunk.join("\n"),
        header: currentHeader,
      });
    }

    return chunks;
  }

  async createEmbedding(text: string): Promise<number[] | null> {
    if (this.settings.embeddingProvider === "openai" && this.settings.openaiApiKey) {
      try {
        // Use requestUrl like obsidian-copilot's safeFetch
        const response = await requestUrl({
          url: "https://api.openai.com/v1/embeddings",
          method: "POST",
          contentType: "application/json",
          headers: {
            "Authorization": `Bearer ${this.settings.openaiApiKey.trim()}`,
          },
          body: JSON.stringify({
            model: this.settings.embeddingModel,
            input: text.slice(0, 8000),
          }),
          throw: false, // Don't throw so we can handle errors
        });

        // Check for error status
        if (response.status >= 400) {
          // Try to get error details
          let errorDetail = `Status ${response.status}`;
          try {
            if (response.text && !response.text.startsWith("<")) {
              errorDetail = response.text;
            }
          } catch { /* ignore */ }
          console.error(`Embedding API error: ${errorDetail}`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          return null;
        }

        // Check if response looks like HTML (error page)
        if (response.text && response.text.trim().startsWith("<")) {
          console.error("Embedding API returned HTML instead of JSON - possible network/proxy issue");
          await new Promise(resolve => setTimeout(resolve, 2000));
          return null;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

        // Safely parse the response
        try {
          const data = response.json;
          if (data && data.data && data.data[0] && data.data[0].embedding) {
            return data.data[0].embedding;
          }
          console.error("Unexpected API response format:", data);
          return null;
        } catch (parseError) {
          console.error("Failed to parse embedding response:", response.text?.slice(0, 200));
          return null;
        }
      } catch (e) {
        console.error("Embedding request failed:", e);
        await new Promise(resolve => setTimeout(resolve, 2000));
        return null;
      }
    }

    return null;
  }

  // ============================================================================
  // SEARCH & RAG
  // ============================================================================

  cosineSimilarity(a: number[], b: number[]): number {
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

  async search(query: string, limit: number = 10): Promise<Source[]> {
    if (this.embeddings.length === 0) {
      return [];
    }

    const queryEmbedding = await this.createEmbedding(query);
    if (!queryEmbedding) return [];

    const scored = this.embeddings.map((entry) => ({
      ...entry,
      score: this.cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => ({
      path: s.path,
      content: s.content,
      score: Math.round(s.score * 100),
      header: s.header,
    }));
  }

  async getFullVaultContent(): Promise<Source[]> {
    const files = this.app.vault.getMarkdownFiles();
    const includeFolders = this.settings.includeFolders;

    const sources: Source[] = [];
    let totalChars = 0;
    const maxChars = 500000;

    for (const file of files) {
      if (totalChars >= maxChars) break;

      if (includeFolders.length > 0) {
        const inIncluded = includeFolders.some((folder) =>
          file.path.startsWith(folder)
        );
        if (!inIncluded) continue;
      }

      const content = await this.app.vault.read(file);
      sources.push({
        path: file.path,
        content: content,
        score: 100,
      });
      totalChars += content.length;
    }

    return sources;
  }

  // ============================================================================
  // AI CHAT
  // ============================================================================

  async chat(
    message: string,
    sources: Source[],
    history: Message[],
    provider?: string,
    model?: string
  ): Promise<string> {
    const useProvider = provider || this.settings.defaultProvider;
    const useModel = model || this.settings.defaultModel;

    // Build context from sources
    let context = "";
    if (sources.length > 0) {
      context = "## Relevant context from your vault:\n\n";
      for (const source of sources) {
        context += `### From: ${source.path}`;
        if (source.header) context += ` (${source.header})`;
        context += `\n${source.content}\n\n`;
      }
    }

    const systemPrompt = `You are Scribe, an intelligent AI assistant with access to the user's notes vault.

Your role is to:
1. Answer questions using the provided context from the vault
2. Help organize and expand upon existing content
3. Generate new content that maintains consistency with existing materials
4. Assist with writing, editing, and brainstorming

Always base your responses on the context provided when available.
Be concise and helpful.`;

    if (useProvider === "openai" && this.settings.openaiApiKey) {
      return this.chatOpenAI(message, context, history, systemPrompt, useModel);
    } else if (useProvider === "gemini" && this.settings.geminiApiKey) {
      return this.chatGemini(message, context, history, systemPrompt);
    } else if (useProvider === "anthropic" && this.settings.anthropicApiKey) {
      return this.chatAnthropic(message, context, history, systemPrompt, useModel);
    } else if (useProvider === "groq" && this.settings.groqApiKey) {
      return this.chatGroq(message, context, history, systemPrompt);
    }

    throw new Error(`Provider ${useProvider} not configured. Please add API key in settings.`);
  }

  async chatOpenAI(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string,
    model: string
  ): Promise<string> {
    const messages: Message[] = [
      { role: "system", content: systemPrompt + "\n\n" + context },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
      }),
    });

    return response.json.choices[0].message.content;
  }

  async chatGemini(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string
  ): Promise<string> {
    const fullPrompt = `${systemPrompt}\n\n${context}\n\nUser: ${message}\n\nAssistant:`;

    const response = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.settings.geminiApiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
      }),
    });

    return response.json.candidates[0].content.parts[0].text;
  }

  async chatAnthropic(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string,
    model: string
  ): Promise<string> {
    const messages = [
      ...history.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": this.settings.anthropicApiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt + "\n\n" + context,
        messages: messages,
      }),
    });

    return response.json.content[0].text;
  }

  async chatGroq(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string
  ): Promise<string> {
    const messages: Message[] = [
      { role: "system", content: systemPrompt + "\n\n" + context },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: "https://api.groq.com/openai/v1/chat/completions",
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messages,
      }),
    });

    return response.json.choices[0].message.content;
  }

  // Streaming chat method
  async chatStream(
    message: string,
    sources: Source[],
    history: Message[],
    onChunk: (chunk: string) => void,
    provider?: string,
    model?: string
  ): Promise<void> {
    const useProvider = provider || this.settings.defaultProvider;
    const useModel = model || this.settings.defaultModel;

    // Build context from sources
    let context = "";
    if (sources.length > 0) {
      context = "## Relevant context from your vault:\n\n";
      for (const source of sources) {
        context += `### From: ${source.path}`;
        if (source.header) context += ` (${source.header})`;
        context += `\n${source.content}\n\n`;
      }
    }

    const systemPrompt = `You are Scribe, an intelligent AI assistant with access to the user's notes vault.

Your role is to:
1. Answer questions using the provided context from the vault
2. Help organize and expand upon existing content
3. Generate new content that maintains consistency with existing materials
4. Assist with writing, editing, and brainstorming

Always base your responses on the context provided when available.
Be concise and helpful.`;

    // For OpenAI, use streaming
    if (useProvider === "openai" && this.settings.openaiApiKey) {
      await this.chatOpenAIStream(message, context, history, systemPrompt, useModel, onChunk);
    } else if (useProvider === "anthropic" && this.settings.anthropicApiKey) {
      await this.chatAnthropicStream(message, context, history, systemPrompt, useModel, onChunk);
    } else {
      // Fallback to non-streaming for other providers
      const response = await this.chat(message, sources, history, provider, model);
      onChunk(response);
    }
  }

  async chatOpenAIStream(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string,
    model: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const messages: Message[] = [
      { role: "system", content: systemPrompt + "\n\n" + context },
      ...history.slice(-10),
      { role: "user", content: message },
    ];

    // Use requestUrl for the initial request, then parse SSE
    const response = await requestUrl({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${this.settings.openaiApiKey.trim()}`,
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: false, // requestUrl doesn't support true streaming, so we'll chunk simulate
      }),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`API error: ${response.status}`);
    }

    // Since requestUrl doesn't support true streaming, deliver full response
    const content = response.json.choices[0].message.content;

    // Simulate streaming by chunking the response
    const words = content.split(" ");
    let accumulated = "";
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join(" ") + " ";
      accumulated += chunk;
      onChunk(chunk);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async chatAnthropicStream(
    message: string,
    context: string,
    history: Message[],
    systemPrompt: string,
    model: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const messages = [
      ...history.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      contentType: "application/json",
      headers: {
        "x-api-key": this.settings.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt + "\n\n" + context,
        messages: messages,
        stream: false,
      }),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`API error: ${response.status}`);
    }

    const content = response.json.content[0].text;

    // Simulate streaming
    const words = content.split(" ");
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3).join(" ") + " ";
      onChunk(chunk);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
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
  pendingMessage: string = "";
  containerEl: HTMLElement;
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sourcePreviewEl: HTMLElement;
  modelInfoEl: HTMLElement;
  fullVaultMode: boolean = false;
  isPreviewMode: boolean = false;

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
    this.containerEl = this.contentEl;
    this.containerEl.empty();
    this.containerEl.addClass("scribe-chat-container");

    // Header
    const header = this.containerEl.createDiv({ cls: "scribe-header" });
    header.createEl("h4", { text: "Scribe AI" });

    const controls = header.createDiv({ cls: "scribe-controls" });

    // Full vault toggle
    const fullVaultLabel = controls.createEl("label", { cls: "scribe-toggle" });
    const fullVaultCheckbox = fullVaultLabel.createEl("input", { type: "checkbox" });
    fullVaultCheckbox.checked = this.fullVaultMode;
    fullVaultCheckbox.addEventListener("change", () => {
      this.fullVaultMode = fullVaultCheckbox.checked;
    });
    fullVaultLabel.createSpan({ text: "Full vault" });

    // Index button
    const indexBtn = controls.createEl("button", { cls: "scribe-btn-small", text: "Index" });
    indexBtn.addEventListener("click", () => this.plugin.indexVault());

    // Model info bar
    this.modelInfoEl = this.containerEl.createDiv({ cls: "scribe-model-info" });
    this.updateModelInfo();

    // Messages container
    this.messagesEl = this.containerEl.createDiv({ cls: "scribe-messages" });

    // Welcome message
    if (this.messages.length === 0) {
      this.showWelcome();
    }

    // Source preview area (hidden by default)
    this.sourcePreviewEl = this.containerEl.createDiv({ cls: "scribe-source-preview" });
    this.sourcePreviewEl.style.display = "none";

    // Input area
    const inputArea = this.containerEl.createDiv({ cls: "scribe-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "scribe-input",
      placeholder: "Ask anything... (Enter to search sources, Shift+Enter for new line)",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (this.isPreviewMode) {
          this.confirmAndSend();
        } else {
          this.searchAndPreview();
        }
      }
    });

    const buttonRow = inputArea.createDiv({ cls: "scribe-button-row" });
    const searchBtn = buttonRow.createEl("button", { cls: "scribe-search-btn", text: "Search Sources" });
    searchBtn.addEventListener("click", () => this.searchAndPreview());

    const sendBtn = buttonRow.createEl("button", { cls: "scribe-send-btn", text: "Send" });
    sendBtn.addEventListener("click", () => {
      if (this.isPreviewMode) {
        this.confirmAndSend();
      } else {
        this.searchAndPreview();
      }
    });
  }

  updateModelInfo() {
    const provider = this.plugin.settings.defaultProvider;
    const model = this.plugin.settings.defaultModel;
    this.modelInfoEl.empty();
    this.modelInfoEl.createSpan({ text: `Model: ${provider}/${model}`, cls: "scribe-model-label" });
  }

  estimateCost(sources: Source[], messageLength: number): string {
    // Rough token estimation: ~4 chars per token
    let totalChars = messageLength;
    for (const source of sources) {
      totalChars += source.content.length;
    }
    const estimatedTokens = Math.ceil(totalChars / 4);

    // Cost per 1M tokens (rough estimates)
    const costs: Record<string, number> = {
      "gpt-5.4-nano": 0.20,
      "gpt-5.4-mini": 0.75,
      "gpt-5.4": 2.50,
      "gpt-5-nano": 0.05,
      "gpt-5-mini": 0.25,
      "gpt-4o-mini": 0.15,
    };

    const model = this.plugin.settings.defaultModel;
    const costPer1M = costs[model] || 0.50;
    const estimatedCost = (estimatedTokens / 1000000) * costPer1M;

    return `~${estimatedTokens.toLocaleString()} tokens (~$${estimatedCost.toFixed(4)})`;
  }

  showWelcome() {
    const welcome = this.messagesEl.createDiv({ cls: "scribe-welcome" });
    welcome.createEl("h3", { text: "Welcome to Scribe AI" });
    welcome.createEl("p", { text: "Ask questions about your vault. I'll search for relevant context and provide informed answers." });

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

    // Show searching indicator
    this.sourcePreviewEl.style.display = "block";
    this.sourcePreviewEl.empty();
    this.sourcePreviewEl.createDiv({ cls: "scribe-preview-searching", text: "Searching for relevant sources..." });

    // Get sources
    if (this.fullVaultMode) {
      this.pendingSources = await this.plugin.getFullVaultContent();
    } else {
      this.pendingSources = await this.plugin.search(message, this.plugin.settings.contextSize);
    }

    this.isPreviewMode = true;
    this.renderSourcePreview();
  }

  renderSourcePreview() {
    this.sourcePreviewEl.empty();

    const header = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-header" });
    header.createEl("h4", { text: "Sources to include:" });

    // Cost estimate
    const costEstimate = this.estimateCost(this.pendingSources, this.pendingMessage.length);
    header.createSpan({ text: costEstimate, cls: "scribe-cost-estimate" });

    // Source list
    const sourceList = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-sources" });

    for (let i = 0; i < this.pendingSources.length; i++) {
      const source = this.pendingSources[i];
      const sourceItem = sourceList.createDiv({ cls: "scribe-preview-source-item" });

      const sourceInfo = sourceItem.createDiv({ cls: "scribe-preview-source-info" });
      sourceInfo.createSpan({ text: source.path.split("/").pop()?.replace(".md", "") || source.path, cls: "scribe-preview-source-name" });
      if (source.header) {
        sourceInfo.createSpan({ text: ` > ${source.header}`, cls: "scribe-preview-source-header" });
      }
      sourceInfo.createSpan({ text: ` (${source.score}%)`, cls: "scribe-preview-source-score" });

      const removeBtn = sourceItem.createEl("button", { text: "×", cls: "scribe-preview-remove-btn" });
      removeBtn.addEventListener("click", () => {
        this.pendingSources.splice(i, 1);
        this.renderSourcePreview();
      });
    }

    // Add more / manual add section
    const addSection = this.sourcePreviewEl.createDiv({ cls: "scribe-preview-add-section" });

    const getMoreBtn = addSection.createEl("button", { text: "Get More Sources", cls: "scribe-btn-small" });
    getMoreBtn.addEventListener("click", async () => {
      const moreSources = await this.plugin.search(this.pendingMessage, this.plugin.settings.contextSize * 2);
      // Add sources that aren't already in the list
      for (const source of moreSources) {
        if (!this.pendingSources.find(s => s.path === source.path && s.header === source.header)) {
          this.pendingSources.push(source);
        }
      }
      this.renderSourcePreview();
    });

    // Manual file add
    const addRow = addSection.createDiv({ cls: "scribe-preview-add-row" });
    const fileInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Add file manually (e.g., Notes/myfile.md)",
      cls: "scribe-preview-add-input"
    });
    const addBtn = addRow.createEl("button", { text: "Add", cls: "scribe-btn-small" });
    addBtn.addEventListener("click", async () => {
      const filePath = fileInput.value.trim();
      if (!filePath) return;

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        this.pendingSources.push({
          path: filePath,
          content: content.slice(0, 2000),
          score: 100,
          header: "Manual"
        });
        fileInput.value = "";
        this.renderSourcePreview();
      } else {
        new Notice("File not found: " + filePath);
      }
    });

    // Action buttons
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

    // Remove welcome if present
    const welcome = this.messagesEl.querySelector(".scribe-welcome");
    if (welcome) welcome.remove();

    // Add user message
    this.addMessage("user", message);
    this.messages.push({ role: "user", content: message });

    // Create streaming response element
    const responseEl = this.messagesEl.createDiv({ cls: "scribe-message assistant" });
    const avatar = responseEl.createDiv({ cls: "scribe-avatar" });
    avatar.setText("S");
    const contentEl = responseEl.createDiv({ cls: "scribe-content" });
    const streamingEl = contentEl.createDiv({ cls: "scribe-streaming-content" });
    streamingEl.setText("Thinking...");
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    try {
      // Stream the response
      let fullResponse = "";
      await this.plugin.chatStream(
        message,
        this.sources,
        this.messages.slice(0, -1),
        (chunk: string) => {
          fullResponse += chunk;
          // Update the streaming element with markdown
          streamingEl.empty();
          MarkdownRenderer.render(
            this.app,
            fullResponse,
            streamingEl,
            "",
            this.plugin
          );
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      );

      // Add sources after streaming complete
      if (this.sources.length > 0 && this.plugin.settings.showSources) {
        const sourcesEl = contentEl.createDiv({ cls: "scribe-sources" });
        sourcesEl.createEl("span", { text: "Sources: ", cls: "scribe-sources-label" });

        for (const source of this.sources.slice(0, 5)) {
          const badge = sourcesEl.createEl("span", { cls: "scribe-source-badge" });
          badge.setText(source.path.split("/").pop()?.replace(".md", "") || source.path);
          badge.addEventListener("click", () => {
            const file = this.app.vault.getAbstractFileByPath(source.path);
            if (file instanceof TFile) {
              this.app.workspace.getLeaf(false).openFile(file);
            }
          });
        }
      }

      // Add action buttons
      const actionsEl = contentEl.createDiv({ cls: "scribe-actions" });
      const copyBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Copy" });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(fullResponse);
        copyBtn.setText("Copied!");
        setTimeout(() => copyBtn.setText("Copy"), 2000);
      });

      const todoBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Save as TODO" });
      todoBtn.addEventListener("click", () => this.saveAsTodo(fullResponse));

      this.messages.push({ role: "assistant", content: fullResponse });
    } catch (e: unknown) {
      streamingEl.setText(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  addMessage(role: "user" | "assistant", content: string, sources?: Source[]) {
    const messageEl = this.messagesEl.createDiv({ cls: `scribe-message ${role}` });

    const avatar = messageEl.createDiv({ cls: "scribe-avatar" });
    avatar.setText(role === "user" ? "Y" : "S");

    const contentEl = messageEl.createDiv({ cls: "scribe-content" });

    // Render markdown
    MarkdownRenderer.render(
      this.app,
      content,
      contentEl,
      "",
      this.plugin
    );

    // Add sources
    if (sources && sources.length > 0 && this.plugin.settings.showSources) {
      const sourcesEl = contentEl.createDiv({ cls: "scribe-sources" });
      sourcesEl.createEl("span", { text: "Sources: ", cls: "scribe-sources-label" });

      for (const source of sources.slice(0, 5)) {
        const badge = sourcesEl.createEl("span", { cls: "scribe-source-badge" });
        badge.setText(source.path.split("/").pop()?.replace(".md", "") || source.path);
        badge.addEventListener("click", () => {
          const file = this.app.vault.getAbstractFileByPath(source.path);
          if (file instanceof TFile) {
            this.app.workspace.getLeaf(false).openFile(file);
          }
        });
      }
    }

    // Add action buttons
    const actionsEl = contentEl.createDiv({ cls: "scribe-actions" });

    // Copy button
    const copyBtn = actionsEl.createEl("button", { cls: "scribe-action-btn", text: "Copy" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content);
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy"), 2000);
    });

    // Save as TODO button
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

    // Convert to checkboxes
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

    // Check for TODOs folder
    let savePath = filename;
    const todosFolder = this.app.vault.getAbstractFileByPath("TODOs");
    if (todosFolder) {
      savePath = `TODOs/${filename}`;
    }

    try {
      const file = await this.app.vault.create(savePath, todoContent);
      new Notice(`Saved to ${savePath}`);
      this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`Failed to save: ${e.message}`);
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
    // Clean up interval when settings tab is closed
    if (this.progressIntervalId !== null) {
      window.clearInterval(this.progressIntervalId);
      this.progressIntervalId = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Scribe AI Settings" });

    // API Keys Section
    containerEl.createEl("h3", { text: "API Keys" });

    new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Required for GPT models and embeddings")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("For Google Gemini models (free tier available)")
      .addText((text) =>
        text
          .setPlaceholder("AI...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Anthropic API Key")
      .setDesc("For Claude models")
      .addText((text) =>
        text
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Groq API Key")
      .setDesc("For fast Groq inference (free tier available)")
      .addText((text) =>
        text
          .setPlaceholder("gsk_...")
          .setValue(this.plugin.settings.groqApiKey)
          .onChange(async (value) => {
            this.plugin.settings.groqApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    // Provider Settings
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
      .setName("Default Model")
      .setDesc("Default model for chat (OpenAI)")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gpt-5.4-nano", "GPT-5.4 Nano ($0.20/1M)")
          .addOption("gpt-5.4-mini", "GPT-5.4 Mini ($0.75/1M)")
          .addOption("gpt-5.4", "GPT-5.4 ($2.50/1M)")
          .addOption("gpt-5-nano", "GPT-5 Nano ($0.05/1M)")
          .addOption("gpt-5-mini", "GPT-5 Mini ($0.25/1M)")
          .addOption("gpt-4o-mini", "GPT-4o Mini ($0.15/1M)")
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value;
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

    // Indexing Settings
    containerEl.createEl("h3", { text: "Indexing Settings" });

    // Include Folders with add/remove UI
    new Setting(containerEl)
      .setName("Include Folders")
      .setDesc("Only index these folders (leave empty for all)");

    const includeFoldersContainer = containerEl.createDiv({ cls: "scribe-tags-container" });
    const includeFoldersInput = includeFoldersContainer.createEl("div", { cls: "scribe-tags-input-row" });
    const includeFoldersText = includeFoldersInput.createEl("input", {
      type: "text",
      placeholder: "Folder name...",
      cls: "scribe-tags-input"
    });
    const includeFoldersAddBtn = includeFoldersInput.createEl("button", { text: "Add", cls: "scribe-tags-add-btn" });
    const includeFoldersTags = includeFoldersContainer.createDiv({ cls: "scribe-tags-list" });

    const renderIncludeFolders = () => {
      includeFoldersTags.empty();
      for (const folder of this.plugin.settings.includeFolders) {
        const tag = includeFoldersTags.createEl("span", { cls: "scribe-tag" });
        tag.createSpan({ text: folder });
        const removeBtn = tag.createEl("span", { text: " ×", cls: "scribe-tag-remove" });
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings.includeFolders = this.plugin.settings.includeFolders.filter(f => f !== folder);
          await this.plugin.saveSettings();
          renderIncludeFolders();
        });
      }
    };

    includeFoldersAddBtn.addEventListener("click", async () => {
      const value = includeFoldersText.value.trim();
      if (value && !this.plugin.settings.includeFolders.includes(value)) {
        this.plugin.settings.includeFolders.push(value);
        await this.plugin.saveSettings();
        includeFoldersText.value = "";
        renderIncludeFolders();
      }
    });

    includeFoldersText.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        includeFoldersAddBtn.click();
      }
    });

    renderIncludeFolders();

    // Excluded Files with add/remove UI
    new Setting(containerEl)
      .setName("Excluded Files")
      .setDesc("Don't index these files");

    const excludedFilesContainer = containerEl.createDiv({ cls: "scribe-tags-container" });
    const excludedFilesInput = excludedFilesContainer.createEl("div", { cls: "scribe-tags-input-row" });
    const excludedFilesText = excludedFilesInput.createEl("input", {
      type: "text",
      placeholder: "File name...",
      cls: "scribe-tags-input"
    });
    const excludedFilesAddBtn = excludedFilesInput.createEl("button", { text: "Add", cls: "scribe-tags-add-btn" });
    const excludedFilesTags = excludedFilesContainer.createDiv({ cls: "scribe-tags-list" });

    const renderExcludedFiles = () => {
      excludedFilesTags.empty();
      for (const file of this.plugin.settings.excludedFiles) {
        const tag = excludedFilesTags.createEl("span", { cls: "scribe-tag" });
        tag.createSpan({ text: file });
        const removeBtn = tag.createEl("span", { text: " ×", cls: "scribe-tag-remove" });
        removeBtn.addEventListener("click", async () => {
          this.plugin.settings.excludedFiles = this.plugin.settings.excludedFiles.filter(f => f !== file);
          await this.plugin.saveSettings();
          renderExcludedFiles();
        });
      }
    };

    excludedFilesAddBtn.addEventListener("click", async () => {
      const value = excludedFilesText.value.trim();
      if (value && !this.plugin.settings.excludedFiles.includes(value)) {
        this.plugin.settings.excludedFiles.push(value);
        await this.plugin.saveSettings();
        excludedFilesText.value = "";
        renderExcludedFiles();
      }
    });

    excludedFilesText.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        excludedFilesAddBtn.click();
      }
    });

    renderExcludedFiles();

    // Context Size as number input
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

    // Chat Settings
    containerEl.createEl("h3", { text: "Chat Settings" });

    new Setting(containerEl)
      .setName("Show Sources")
      .setDesc("Display source references in chat responses")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSources)
          .onChange(async (value) => {
            this.plugin.settings.showSources = value;
            await this.plugin.saveSettings();
          })
      );

    // Index Button
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Index Vault")
      .setDesc(`Currently indexed: ${this.plugin.embeddings.length} chunks`)
      .addButton((btn) =>
        btn
          .setButtonText("Re-index Now")
          .onClick(() => this.plugin.indexVault())
      )
      .addButton((btn) =>
        btn
          .setButtonText("Cancel")
          .setWarning()
          .onClick(() => this.plugin.cancelIndexing())
      );

    // Indexing Progress Display
    const progressContainer = containerEl.createDiv({ cls: "scribe-progress-container" });
    const progressBar = progressContainer.createDiv({ cls: "scribe-progress-bar" });
    const progressFill = progressBar.createDiv({ cls: "scribe-progress-fill" });
    const progressText = progressContainer.createDiv({ cls: "scribe-progress-text" });

    // Update progress display
    const updateProgress = () => {
      if (this.plugin.indexing) {
        progressContainer.style.display = "block";
        const percent = this.plugin.indexingProgress.total > 0
          ? (this.plugin.indexingProgress.current / this.plugin.indexingProgress.total) * 100
          : 0;
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

    // Initial update
    updateProgress();

    // Clear any existing interval
    if (this.progressIntervalId !== null) {
      window.clearInterval(this.progressIntervalId);
    }

    // Poll for updates while settings tab is open
    this.progressIntervalId = window.setInterval(updateProgress, 200);
  }
}
