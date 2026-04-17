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
  includeFolders: string;
  excludedFiles: string;
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
  includeFolders: "",
  excludedFiles: "",
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  async indexVault() {
    if (this.indexing) {
      new Notice("Already indexing...");
      return;
    }

    this.indexing = true;
    new Notice("Indexing vault...");

    const files = this.app.vault.getMarkdownFiles();
    const includeFolders = this.settings.includeFolders
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f);
    const excludedFiles = this.settings.excludedFiles
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f);

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

    this.embeddings = [];

    for (let i = 0; i < filesToIndex.length; i++) {
      const file = filesToIndex[i];
      try {
        const content = await this.app.vault.read(file);
        const chunks = this.chunkText(content, file.path);

        for (const chunk of chunks) {
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

        if ((i + 1) % 10 === 0) {
          new Notice(`Indexed ${i + 1}/${filesToIndex.length} files...`);
        }
      } catch (e) {
        console.error(`Failed to index ${file.path}:`, e);
      }
    }

    await this.saveEmbeddings();
    this.indexing = false;
    new Notice(`Indexed ${this.embeddings.length} chunks from ${filesToIndex.length} files`);
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
        const response = await requestUrl({
          url: "https://api.openai.com/v1/embeddings",
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.settings.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: text,
          }),
        });

        return response.json.data[0].embedding;
      } catch (e) {
        console.error("Embedding error:", e);
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
    const includeFolders = this.settings.includeFolders
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f);

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
}

// ============================================================================
// CHAT VIEW
// ============================================================================

class ScribeChatView extends ItemView {
  plugin: ScribePlugin;
  messages: Message[] = [];
  sources: Source[] = [];
  containerEl: HTMLElement;
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  fullVaultMode: boolean = false;

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

    // Messages container
    this.messagesEl = this.containerEl.createDiv({ cls: "scribe-messages" });

    // Welcome message
    if (this.messages.length === 0) {
      this.showWelcome();
    }

    // Input area
    const inputArea = this.containerEl.createDiv({ cls: "scribe-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "scribe-input",
      placeholder: "Ask anything...",
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    const sendBtn = inputArea.createEl("button", { cls: "scribe-send-btn", text: "Send" });
    sendBtn.addEventListener("click", () => this.sendMessage());
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

  async sendMessage() {
    const message = this.inputEl.value.trim();
    if (!message) return;

    this.inputEl.value = "";

    // Remove welcome if present
    const welcome = this.messagesEl.querySelector(".scribe-welcome");
    if (welcome) welcome.remove();

    // Add user message
    this.addMessage("user", message);
    this.messages.push({ role: "user", content: message });

    // Show loading
    const loadingEl = this.messagesEl.createDiv({ cls: "scribe-message assistant" });
    loadingEl.createSpan({ text: "Thinking...", cls: "scribe-loading" });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    try {
      // Get sources
      if (this.fullVaultMode) {
        this.sources = await this.plugin.getFullVaultContent();
      } else {
        this.sources = await this.plugin.search(message, this.plugin.settings.contextSize);
      }

      // Get AI response
      const response = await this.plugin.chat(
        message,
        this.sources,
        this.messages.slice(0, -1)
      );

      loadingEl.remove();

      // Add assistant message
      this.addMessage("assistant", response, this.sources);
      this.messages.push({ role: "assistant", content: response });
    } catch (e) {
      loadingEl.remove();
      this.addMessage("assistant", `Error: ${e.message}`);
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

  constructor(app: App, plugin: ScribePlugin) {
    super(app, plugin);
    this.plugin = plugin;
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

    // Indexing Settings
    containerEl.createEl("h3", { text: "Indexing Settings" });

    new Setting(containerEl)
      .setName("Include Folders")
      .setDesc("Only index these folders (comma-separated, leave empty for all)")
      .addText((text) =>
        text
          .setPlaceholder("Database, Notes, Projects")
          .setValue(this.plugin.settings.includeFolders)
          .onChange(async (value) => {
            this.plugin.settings.includeFolders = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded Files")
      .setDesc("Don't index these files (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder("Untitled.md, TODO.md")
          .setValue(this.plugin.settings.excludedFiles)
          .onChange(async (value) => {
            this.plugin.settings.excludedFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Context Size")
      .setDesc("Number of chunks to include as context (5-50)")
      .addSlider((slider) =>
        slider
          .setLimits(5, 50, 5)
          .setValue(this.plugin.settings.contextSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.contextSize = value;
            await this.plugin.saveSettings();
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
      );
  }
}
