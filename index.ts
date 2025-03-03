import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as lancedb from "@lancedb/lancedb";
import { runJxa } from "run-jxa";
import path from "node:path";
import os from "node:os";
import TurndownService from "turndown";
import {
  EmbeddingFunction,
  LanceSchema,
  register,
} from "@lancedb/lancedb/embedding";
import { type Float, Float32, Utf8 } from "apache-arrow";
import { pipeline } from "@huggingface/transformers";

const { turndown } = new TurndownService();
const db = await lancedb.connect(
  path.join(os.homedir(), ".mcp-apple-notes", "data")
);
const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2"
);

@register("openai")
export class OnDeviceEmbeddingFunction extends EmbeddingFunction<string> {
  toJSON(): object {
    return {};
  }
  ndims() {
    return 384;
  }
  embeddingDataType(): Float {
    return new Float32();
  }
  async computeQueryEmbeddings(data: string) {
    const output = await extractor(data, { pooling: "mean" });
    return output.data as number[];
  }
  async computeSourceEmbeddings(data: string[]) {
    return await Promise.all(
      data.map(async (item) => {
        const output = await extractor(item, { pooling: "mean" });

        return output.data as number[];
      })
    );
  }
}

const func = new OnDeviceEmbeddingFunction();

const notesTableSchema = LanceSchema({
  title: func.sourceField(new Utf8()),
  content: func.sourceField(new Utf8()),
  creation_date: func.sourceField(new Utf8()),
  modification_date: func.sourceField(new Utf8()),
  vector: func.vectorField(),
});

const QueryNotesSchema = z.object({
  query: z.string(),
});

const GetNoteSchema = z.object({
  title: z.string(),
});

const server = new Server(
  {
    name: "my-apple-notes-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list-notes",
        description: "Lists just the titles of all my Apple Notes",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "index-notes",
        description:
          "Index all my Apple Notes for Semantic Search. Please tell the user that the sync takes couple of seconds up to couple of minutes depending on how many notes you have.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "get-note",
        description: "Get a note full content and details by title",
        inputSchema: {
          type: "object",
          properties: {
            title: z.string(),
          },
          required: ["title"],
        },
      },
      {
        name: "search-notes",
        description: "Search for notes by title or content",
        inputSchema: {
          type: "object",
          properties: {
            query: z.string(),
          },
          required: ["query"],
        },
      },
      {
        name: "create-note",
        description:
          "Create a new Apple Note with specified title and content. Must be in HTML format WITHOUT newlines",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "content"],
        },
      },
    ],
  };
});

const getNotes = async () => {
  const notes = await runJxa(`
    const app = Application('Notes');
app.includeStandardAdditions = true;
const notes = Array.from(app.notes());
const titles = notes.map(note => note.properties().name);
return titles;
  `);

  return notes as string[];
};

const getNoteDetailsByTitle = async (title: string) => {
  const note = await runJxa(
    `const app = Application('Notes');
    const title = "${title}"
    
    try {
        const note = app.notes.whose({name: title})[0];
        
        const noteInfo = {
            title: note.name(),
            content: note.body(),
            creation_date: note.creationDate().toLocaleString(),
            modification_date: note.modificationDate().toLocaleString()
        };
        
        return JSON.stringify(noteInfo);
    } catch (error) {
        return "{}";
    }`
  );

  return JSON.parse(note as string) as {
    title: string;
    content: string;
    creation_date: string;
    modification_date: string;
  };
};

export const indexNotes = async (notesTable: any) => {
  const start = performance.now();
  let report = "";
  const allNotes = (await getNotes()) || [];
  const notesDetails = await Promise.all(
    allNotes.map((note) => {
      try {
        return getNoteDetailsByTitle(note);
      } catch (error) {
        report += `Error getting note details for ${note}: ${error.message}\n`;
        return {} as any;
      }
    })
  );

  const chunks = notesDetails
    .filter((n) => n.title)
    .map((node) => {
      try {
        return {
          ...node,
          content: turndown(node.content || ""), // this sometimes fails
        };
      } catch (error) {
        return node;
      }
    })
    .map((note, index) => ({
      id: index.toString(),
      title: note.title,
      content: note.content, // turndown(note.content || ""),
      creation_date: note.creation_date,
      modification_date: note.modification_date,
    }));

  await notesTable.add(chunks);

  return {
    chunks: chunks.length,
    report,
    allNotes: allNotes.length,
    time: performance.now() - start,
  };
};

export const createNotesTable = async (overrideName?: string) => {
  const start = performance.now();
  const notesTable = await db.createEmptyTable(
    overrideName || "notes",
    notesTableSchema,
    {
      mode: "create",
      existOk: true,
    }
  );

  const indices = await notesTable.listIndices();
  if (!indices.find((index) => index.name === "content_idx")) {
    await notesTable.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
  }

  return {
    notesTable,
    time: performance.now() - start,
  };
};

const createNote = async (title: string, content: string) => {
  try {
    const result = await runJxa(`
      const app = Application('Notes');
      app.includeStandardAdditions = true;
      
      const title = "${title.replace(/"/g, '\\"')}";
      const content = \`${content.replace(/`/g, "\\`")}\`;
      
      try {
        const note = app.make({new: "note", withProperties: {name: title, body: content}});
        return JSON.stringify({success: true, message: "Note created successfully"});
      } catch (error) {
        return JSON.stringify({success: false, message: error.message});
      }
    `);
    
    return JSON.parse(result as string) as {
      success: boolean;
      message: string;
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create note: ${error.message}`,
    };
  }
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, parameters } = request;

  if (name === "list-notes") {
    try {
      const notes = await getNotes();
      return createTextResponse(
        `Found ${notes.length} notes:\n\n${notes.join("\n")}`
      );
    } catch (error) {
      return createTextResponse(`Error listing notes: ${error.message}`);
    }
  } else if (name === "index-notes") {
    try {
      const { notesTable } = await createNotesTable();
      const result = await indexNotes(notesTable);
      return createTextResponse(
        `Successfully indexed ${result.chunks} notes in ${Math.round(
          result.time
        )}ms.`
      );
    } catch (error) {
      return createTextResponse(`Error indexing notes: ${error.message}`);
    }
  } else if (name === "get-note") {
    try {
      const { title } = GetNoteSchema.parse(parameters);
      const note = await getNoteDetailsByTitle(title);
      if (!note.title) {
        return createTextResponse(`Note with title "${title}" not found.`);
      }
      return createTextResponse(
        `# ${note.title}\n\n${turndown(note.content || "")}\n\nCreated: ${
          note.creation_date
        }\nLast Modified: ${note.modification_date}`
      );
    } catch (error) {
      return createTextResponse(`Error getting note: ${error.message}`);
    }
  } else if (name === "search-notes") {
    try {
      const { query } = QueryNotesSchema.parse(parameters);
      const { notesTable } = await createNotesTable();
      const results = await searchAndCombineResults(notesTable, query);
      return createTextResponse(results);
    } catch (error) {
      return createTextResponse(`Error searching notes: ${error.message}`);
    }
  } else if (name === "create-note") {
    try {
      const { title, content } = parameters as { title: string; content: string };
      const result = await createNote(title, content);
      
      if (result.success) {
        return createTextResponse(`Created note "${title}" successfully.`);
      } else {
        return createTextResponse(`Failed to create note. ${result.message}`);
      }
    } catch (error) {
      return createTextResponse(`Failed to create note. Please check your Apple Notes configuration.`);
    }
  }

  return createTextResponse(`Unknown tool: ${name}`);
});

const createTextResponse = (text: string) => ({
  type: "text",
  text,
});

// Combine semantic search and full-text search results
export const searchAndCombineResults = async (
  notesTable: lancedb.Table,
  query: string,
  limit = 20
) => {
  // Semantic search
  const semanticResults = await notesTable
    .vectorSearch(query, { topK: limit })
    .select(["title", "content", "creation_date", "modification_date"])
    .execute();

  // Full-text search
  const fullTextResults = await notesTable
    .search("content", query)
    .select(["title", "content", "creation_date", "modification_date"])
    .limit(limit)
    .execute();

  // Combine and deduplicate results
  const allResults = [...semanticResults, ...fullTextResults];
  const uniqueResults = Array.from(
    new Map(allResults.map((item) => [item.title, item])).values()
  );

  const processResults = (results: any[], startRank: number) => {
    return results
      .map((result, index) => {
        const rank = startRank + index;
        const snippet =
          result.content.length > 300
            ? `${result.content.substring(0, 300)}...`
            : result.content;
        return `${rank}. **${result.title}**\n${snippet}\n`;
      })
      .join("\n");
  };

  const resultText = processResults(uniqueResults.slice(0, limit), 1);

  return `Found ${uniqueResults.length} notes matching "${query}":\n\n${resultText}`;
};

const transport = new StdioServerTransport();
server.listen(transport);