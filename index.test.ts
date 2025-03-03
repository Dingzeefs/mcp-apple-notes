import { describe, expect, it, mock, spyOn } from "bun:test";
import { indexNotes, createNotesTable, searchAndCombineResults } from "./index";
import * as lancedb from "@lancedb/lancedb";

// Mock runJxa
mock.module("run-jxa", () => ({
  runJxa: async (script: string) => {
    if (script.includes("app.notes()")) {
      return ["Note 1", "Note 2", "Note 3"];
    }
    
    if (script.includes("note.properties()")) {
      return ["Note 1", "Note 2", "Note 3"];
    }
    
    if (script.includes("app.notes.whose")) {
      return JSON.stringify({
        title: "Note 1",
        content: "<div>This is the content of Note 1</div>",
        creation_date: "2023-01-01",
        modification_date: "2023-01-02"
      });
    }
    
    if (script.includes("app.make")) {
      return JSON.stringify({
        success: true,
        message: "Note created successfully"
      });
    }
    
    return "{}";
  }
}));

// Mock LanceDB
const mockTable = {
  add: mock.fn(),
  listIndices: mock.fn().mockReturnValue([]),
  createIndex: mock.fn(),
  vectorSearch: mock.fn().mockReturnValue({
    select: mock.fn().mockReturnValue({
      execute: mock.fn().mockReturnValue([
        {
          title: "Note 1",
          content: "Content of Note 1",
          creation_date: "2023-01-01",
          modification_date: "2023-01-02"
        }
      ])
    })
  }),
  search: mock.fn().mockReturnValue({
    select: mock.fn().mockReturnValue({
      limit: mock.fn().mockReturnValue({
        execute: mock.fn().mockReturnValue([
          {
            title: "Note 2",
            content: "Content of Note 2",
            creation_date: "2023-01-03",
            modification_date: "2023-01-04"
          }
        ])
      })
    })
  })
};

mock.module("@lancedb/lancedb", () => ({
  connect: async () => ({
    createEmptyTable: async () => mockTable
  }),
  Index: {
    fts: () => ({})
  }
}));

describe("Apple Notes MCP Server", () => {
  it("should index notes", async () => {
    const result = await indexNotes(mockTable);
    expect(result.chunks).toBe(3);
    expect(mockTable.add).toHaveBeenCalled();
  });

  it("should create notes table", async () => {
    const spy = spyOn(mockTable, "listIndices").mockReturnValueOnce([]);
    const result = await createNotesTable();
    expect(result.notesTable).toBe(mockTable);
    expect(spy).toHaveBeenCalled();
    expect(mockTable.createIndex).toHaveBeenCalled();
  });

  it("should search and combine results", async () => {
    const result = await searchAndCombineResults(mockTable, "test query");
    expect(result).toContain("Found 2 notes matching");
    expect(result).toContain("Note 1");
    expect(result).toContain("Note 2");
  });
});