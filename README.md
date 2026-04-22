# Archivist AI - Obsidian Plugin

A RAG-powered AI assistant for your Obsidian vault. Chat with context from your notes, find connections, generate content, and more.

## Features

### Chat & Search
- **RAG Chat** - AI responses grounded in your vault content
- **Semantic Search** - Find notes by meaning, not just keywords
- **Smart Connections** - Discover related notes automatically
- **Source Preview** - Review and edit sources before sending

### Writing Assistance
- **Summarize Note** - Generate concise summaries of any note
- **Continue Writing** - AI continues from your cursor position
- **Expand Selection** - Add detail to selected text
- **Simplify Selection** - Make text clearer and easier to understand
- **Fix Grammar** - Correct grammar and spelling errors

### Organization
- **Suggest Tags** - AI-suggested tags based on content
- **Suggest Backlinks** - Find notes you should link to
- **Find Duplicates** - Discover semantically similar notes
- **Find Orphans** - Find notes with no connections

### Generation
- **Generate Note** - Create new notes from a topic
- **Generate Flashcards** - Create Q&A cards from any note
- **Generate Outline** - Create structured outlines
- **Save Chat History** - Export conversations as notes

### Providers
- **OpenAI** - GPT-5 family models
- **Google Gemini** - Free tier available
- **Anthropic Claude** - High quality responses
- **Groq** - Fast inference, free tier

## Installation

### From Community Plugins
1. Open Settings > Community Plugins
2. Search for "Archivist AI"
3. Install and enable

### Manual Installation
1. Download the latest release
2. Extract to `.obsidian/plugins/obsidian-scribe`
3. Enable in Settings > Community Plugins

### From Source
```bash
git clone https://github.com/MitchellTLarsen/obsidian-scribe.git
cd obsidian-scribe
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-scribe` folder.

## Setup

1. Open Settings > Archivist AI
2. Add at least one API key:
   - **OpenAI** - Required for embeddings and GPT models
   - **Gemini** - Free tier available
   - **Claude** - High quality responses
   - **Groq** - Fast inference, free tier
3. Click "Index Vault" to create embeddings
4. Open Archivist AI from the ribbon icon

## Usage

### Commands

Access all commands via Command Palette (`Cmd/Ctrl+P`) and type "Scribe":

| Command | Description |
|---------|-------------|
| Open Archivist AI Chat | Open the chat panel |
| Open Scribe Connections | View related notes |
| Open Semantic Search | Search by meaning |
| Index vault for RAG | Re-index all notes |
| Summarize current note | Generate note summary |
| Summarize selection | Summarize selected text |
| Continue writing | AI continues from cursor |
| Expand selection | Add detail to selection |
| Simplify selection | Make text clearer |
| Fix grammar | Correct errors |
| Suggest tags | AI-suggested tags |
| Suggest backlinks | Find related notes to link |
| Find duplicates | Find similar notes |
| Find orphan notes | Find unconnected notes |
| Generate flashcards | Create Q&A cards |
| Generate note | Create note from topic |
| Generate outline | Create structured outline |
| Save chat history | Export chat as note |

### Ribbon Icons
- Chat (speech bubble) - Open Scribe Chat
- Connections (branch) - View note connections
- Search (magnifying glass) - Semantic search

### Context Menu
Right-click in the editor to access:
- Summarize selection
- Expand selection
- Simplify selection
- Fix grammar
- Continue writing
- Suggest tags

## Settings

| Setting | Description |
|---------|-------------|
| **API Keys** | Add keys for OpenAI, Gemini, Claude, Groq |
| **Default Provider** | Which AI to use by default |
| **Models** | Select model for each provider |
| **Include Folders** | Only index these folders |
| **Excluded Files** | Don't index these files |
| **Context Size** | Number of chunks to include (1-100) |
| **Show Sources** | Display source links in responses |

## How It Works

1. **Indexing** - Splits notes into chunks, creates embeddings via OpenAI
2. **Search** - Converts your query to an embedding, finds similar chunks
3. **Context** - Top matching chunks are included in the AI prompt
4. **Generation** - AI responds based on your notes

## Cost Reference

| Model | Input $/1M tokens |
|-------|-------------------|
| gpt-5-nano | $0.05 |
| gpt-5-mini | $0.25 |
| gpt-4o-mini | $0.15 |
| text-embedding-3-small | $0.02 |
| gemini-2.0-flash | FREE |
| groq (llama) | FREE |

## Privacy

- API keys are stored locally in your vault
- Your notes are sent to AI providers only when you use features
- Embeddings are cached locally for performance
- No data is sent to third parties beyond the AI providers you configure

## License

MIT

## Support

- [GitHub Issues](https://github.com/MitchellTLarsen/obsidian-scribe/issues)
- [Documentation](https://github.com/MitchellTLarsen/obsidian-scribe/wiki)
