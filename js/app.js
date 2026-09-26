import { supabase } from "./supabase.js";
import { confirmAction, actionMsg, openUpgradeModal } from "https://app.loghue.com/js/utils/modals.js";
import { sanitizeHTML } from "https://app.loghue.com/js/utils.js";
import { setButtonLoading } from "https://ui.scybud.com/js/ui.js";
import {
  fetchNoteById,
  fetchUserFolders as fetchFolders,
} from "./data/notesDb.js";
import { formatDateTimeRelatively } from "https://app.loghue.com/js/utils/time.js";
import { sessionState } from "./session.js";
import {
  createTable,
  renderTableWidget,
  renderTableToHTML,
} from "https://app.loghue.com/js/components/tables/tableWidget.js";
import { registerTableEmbedBlot } from "https://app.loghue.com/js/components/tables/TableembedBlot.js";

// Global state
let quill = null;
let currentNoteId = null;
let currentNoteType = "text"; // "text" | "sketch" | "table"
let savedNoteDetails = [];
let isLoading = false;
let isSaving = false;
let lastSavedSnapshot = "";
let autosaveTimer = null;

const AUTOSAVE_DELAY = 1500;

// Table state: inline tables for text notes, single-entry array for table notes
let currentTables = [];
let isMountingEmbeds = false;
let isSavingTableNote = false;
let lastSavedTableSnapshot = "";
let tableAutosaveTimer = null;

// Sketch state
let board = null;
let context = null;
let isdrawing = false;
let sketchTool = "pen"; // "pen" | "eraser" | "text"
let undoStack = [];
const UNDO_LIMIT = 20;
let isSavingSketch = false;
let lastSavedSketchSnapshot = "";
let sketchAutosaveTimer = null;
const BOARD_WIDTH = 1920;
const BOARD_HEIGHT = 1080;

// Folder state
let savedFolders = [];
let folderCollapseState = loadFolderCollapseState();
let noteMenuOutsideClickAttached = false;

function loadFolderCollapseState() {
  try {
    return JSON.parse(localStorage.getItem("noteFolderCollapse") || "{}");
  } catch {
    return {};
  }
}

function persistFolderCollapseState() {
  localStorage.setItem(
    "noteFolderCollapse",
    JSON.stringify(folderCollapseState),
  );
}

function setLoading(state) {
  isLoading = state;
  const notesContainer = document.querySelector(".notesContainer");
  notesContainer?.classList.toggle("isLoading", state);
}

function setSaveStatus(text) {
  const el = document.getElementById("saveStatus");
  if (el) el.textContent = text;
}

function setSketchSaveStatus(text) {
  const el = document.getElementById("sketchSaveStatus");
  if (el) el.textContent = text;
}

function setTableSaveStatus(text) {
  const el = document.getElementById("tableSaveStatus");
  if (el) el.textContent = text;
}

// Autosave: text notes
function scheduleAutosave() {
  clearAutosaveTimer();
  autosaveTimer = setTimeout(runAutosave, AUTOSAVE_DELAY);
}

function clearAutosaveTimer() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

async function runAutosave() {
  if (isSaving || !quill) return;

  const titleInput = document.getElementById("noteTitle");
  if (!titleInput) return;

  const title = titleInput.value;
  const content = sanitizeHTML(getSavableContentHTML());
  const tableSnapshot = JSON.stringify(currentTables);
  const snapshot = title + content + tableSnapshot;

  if (snapshot === lastSavedSnapshot) return;

  isSaving = true;
  setSaveStatus("Saving…");

  try {
    const { error, created } = await persistNote(title, content, currentTables);

    if (error) {
      console.error(error);
      setSaveStatus("Autosave failed");
      return;
    }

    lastSavedSnapshot = snapshot;
    setSaveStatus("Saved");

    if (created) {
      await refreshSidebarOnly();
    } else {
      updateSidebarEntry(currentNoteId, title, content);
    }
  } finally {
    isSaving = false;
  }
}

// Autosave: sketch notes
function scheduleSketchAutosave() {
  clearSketchAutosaveTimer();
  sketchAutosaveTimer = setTimeout(runSketchAutosave, AUTOSAVE_DELAY);
}

function clearSketchAutosaveTimer() {
  if (sketchAutosaveTimer) {
    clearTimeout(sketchAutosaveTimer);
    sketchAutosaveTimer = null;
  }
}

async function runSketchAutosave() {
  if (
    isSavingSketch ||
    !currentNoteId ||
    currentNoteType !== "sketch" ||
    !board
  )
    return;

  const titleInput = document.getElementById("sketchTitle");
  const title = titleInput ? titleInput.value : "";
  const imageData = board.toDataURL("image/png");
  const snapshot = title + imageData;

  if (snapshot === lastSavedSketchSnapshot) return;

  isSavingSketch = true;
  setSketchSaveStatus("Saving…");

  const { error } = await supabase
    .from("personal_notes")
    .update({
      title: title || "Untitled Sketch",
      canvas_data: imageData,
      updated_at: new Date(),
    })
    .eq("id", currentNoteId);

  isSavingSketch = false;

  if (error) {
    console.error(error);
    setSketchSaveStatus("Autosave failed");
    return;
  }

  lastSavedSketchSnapshot = snapshot;
  setSketchSaveStatus("Saved");
  updateSidebarEntry(currentNoteId, title, null);
}

// Autosave: standalone table notes
function scheduleTableAutosave() {
  clearTableAutosaveTimer();
  tableAutosaveTimer = setTimeout(runTableAutosave, AUTOSAVE_DELAY);
}

function clearTableAutosaveTimer() {
  if (tableAutosaveTimer) {
    clearTimeout(tableAutosaveTimer);
    tableAutosaveTimer = null;
  }
}

async function runTableAutosave() {
  if (isSavingTableNote || !currentNoteId || currentNoteType !== "table")
    return;

  const titleInput = document.getElementById("tableTitle");
  const title = titleInput ? titleInput.value : "";
  const snapshot = title + JSON.stringify(currentTables);

  if (snapshot === lastSavedTableSnapshot) return;

  isSavingTableNote = true;
  setTableSaveStatus("Saving…");

  const { error } = await supabase
    .from("personal_notes")
    .update({
      title: title || "Untitled Table",
      table_data: currentTables,
      updated_at: new Date(),
    })
    .eq("id", currentNoteId);

  isSavingTableNote = false;

  if (error) {
    console.error(error);
    setTableSaveStatus("Autosave failed");
    return;
  }

  lastSavedTableSnapshot = snapshot;
  setTableSaveStatus("Saved");
  updateSidebarEntry(currentNoteId, title, null);
}

// Init notes UI
async function initNotes() {
  setLoading(true);

  const params = new URLSearchParams(window.location.search);
  const noteId = params.get("note");
  const forceNew = params.get("new") === "1";

  const editorContainer = document.getElementById("editorContainer");

  if (!editorContainer) {
    setLoading(false);
    return;
  }

  editorContainer.innerHTML = `
    <div id="textEditorPane">
  <div class="editorTop">
    <input id="noteTitle" name="noteTitle" placeholder="Note title" class="noteTitle inputField" />
    <div class="actionBtnsContainer">
    <span id="saveStatus" class="saveStatus"></span>
    <button id="expandNoteBtn" data-title="Resize editor" aria-label="Resize editor" class="btn tooltip actionBtn" type="button">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="3" />
          <line x1="7" y1="24" x2="21" y2="24" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
        </svg>
      </button>
      <button id="insertTableBtn" data-title="Insert table" aria-label="Insert table" class="btn tooltip actionBtn" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 4v16" />
        </svg>
      </button>
      <button id="saveNoteBtn" class="btn-sm btn notesActionBtn">Save</button>
      <select id="exportNotesBtn" class="btn-sm btn btn-secondary notesActionBtn">
        <option value="">Export As</option>
        <option value="pdf">PDF</option>
        <option value="docx">DOCX</option>
        <option value="html">HTML</option>
        <option value="txt">TXT</option>
        <option value="md">Markdown</option>
      </select>
    </div>
  </div>
  <div id="editor"></div>
</div>

    <div id="sketchEditorPane" hidden>
      <div class="editorTop">
        <input id="sketchTitle" name="sketchTitle" placeholder="Sketch title" class="noteTitle inputField" />
        <div class="actionBtnsContainer">
          <span id="sketchSaveStatus" class="saveStatus"></span>
          <button id="expandCanvasBtn" data-title="Resize canvas" arial-label="Resize canvas" class="btn tooltip actionBtn" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="3" />
  <line x1="7" y1="24" x2="21" y2="24" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
</svg>
         </button>
          <div class="newNoteActionContainer">
            <button onclick="sketchToolbarContainer.hidden ^= 1" class="btn actionBtn" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1z" />
              </svg>
              Tools
            </button>
            <div class="dropdown sketchToolbarContainer" id="sketchToolbarContainer" hidden>
              <div class="dropdown-list">
                <div class="sketchToolInputRow">
                  <input type="color" id="color-picker" value="#000000" class="tooltip" data-title="Color" title="Color" />
                  <input type="range" id="brush-size" min="1" max="50" value="5" class="tooltip" data-title="Brush size" title="Brush size" />
                </div>
                <button id="pen-tool-button" class="btn active" type="button">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
  <span class="toolLabel">Pen</span>
</button>
                <button id="eraser-tool-button" class="btn" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 20H8.5L3 14.5a1 1 0 0 1 0-1.4l9-9a1 1 0 0 1 1.4 0l7 7a1 1 0 0 1 0 1.4L14 19" />
                    <path d="M8 12l7 7" />
                  </svg>
                  <span class="toolLabel">Eraser</span>
                </button>
                <button id="undo-button" class="btn" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 10h10a5 5 0 0 1 0 10H8" />
                    <polyline points="7 5 3 10 7 15" />
                  </svg>
                  <span class="toolLabel">Undo</span>
                </button>
                <button id="fill-button" class="btn" type="button">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 11l-8-8-8.5 8.5a2 2 0 0 0 0 2.8L9 21l10-10z" />
                <path d="M5 13h11" />
                <circle cx="20" cy="18" r="2" />
                </svg>
                <span class="toolLabel">Fill</span>
                </button>
                <button id="download-button" class="btn" type="button">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12" />
                <polyline points="7 10 12 15 17 10" />
                <path d="M5 21h14" />
                </svg>
                <span class="toolLabel">Download PNG</span>
                </button>
                <button id="clear-button" class="btn danger" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                  <span class="toolLabel">Clear</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="sketchCanvasWrap">
        <canvas id="board"></canvas>
      </div>
    </div>

    <div id="tableEditorPane" hidden>
      <div class="editorTop">
        <input id="tableTitle" name="tableTitle" placeholder="Table title" class="noteTitle inputField" />
        <div class="actionBtnsContainer">
          <span id="tableSaveStatus" class="saveStatus"></span>
          <button id="expandTableBtn" data-title="Resize table" aria-label="Resize table" class="btn tooltip actionBtn" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="4" width="18" height="14" rx="2" stroke="currentColor" stroke-width="3" />
              <line x1="7" y1="24" x2="21" y2="24" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
            </svg>
          </button>
          <button id="saveTableBtn" class="btn-sm btn notesActionBtn">Save</button>
          <select id="exportTableBtn" class="btn-sm btn btn-secondary notesActionBtn">
            <option value="">Export As</option>
            <option value="pdf">PDF</option>
            <option value="html">HTML</option>
          </select>
        </div>
      </div>
      <div id="standaloneTableWrap"></div>
    </div>
  `;

  registerTableEmbedBlot(Quill);

  const FontAttributor = Quill.import("attributors/class/font");
  FontAttributor.whitelist = [
    "sans serif",
    "serif",
    "sofia",
    "slabo",
    "roboto",
    "inconsolata",
    "ubuntu",
  ];
  const Color = Quill.import("formats/color");
  const Background = Quill.import("formats/background");

  Quill.register(FontAttributor, true);
  Quill.register(Color, true);
  Quill.register(Background, true);

  quill = new Quill("#editor", {
    modules: {
      toolbar: [
        [{ header: [2, 3, 4, 5, 6, false] }],
        [{ font: FontAttributor.whitelist }],
        ["bold", "italic", "underline", "link"],
        [{ color: [] }, { background: [] }],
        [
          { list: "ordered" },
          { list: "bullet" },
          { list: "check" },
          { align: [] },
        ],
        ["code-block"],
      ],
    },
    placeholder: "Start typing...",
    theme: "snow",
  });

  const toolbar = quill.getModule("toolbar");

  toolbar.addHandler("link", function () {
    const range = quill.getSelection();
    if (!range) return;

    if (range.length === 0) {
      const url = prompt("Enter URL:");
      if (url) {
        quill.insertText(range.index, url, "link", url);
        quill.setSelection(range.index + url.length, 0);
      }
      return;
    }

    const value = prompt("Enter URL:");
    if (value) quill.format("link", value);
  });

  const Delta = Quill.import("delta");
  quill.clipboard.addMatcher(".ql-table-embed", (node, delta) => {
    const id = node.getAttribute("data-table-id");
    if (!id) return delta;
    return new Delta().insert({ "table-embed": { id } });
  });

  initSketchBoard();
  attachExpandToggle("expandCanvasBtn", "sketchEditorPane");
  attachExpandToggle("expandNoteBtn", "textEditorPane");
  attachExpandToggle("expandTableBtn", "tableEditorPane");

  document.getElementById("saveNoteBtn").addEventListener("click", saveNote);

  document.getElementById("exportNotesBtn").addEventListener("change", (e) => {
    const type = e.target.value;
    if (!type) return;
    exportCurrentNote(type, false);
    e.target.value = "";
  });

  document
    .getElementById("insertTableBtn")
    .addEventListener("click", insertInlineTable);
  document
    .getElementById("saveTableBtn")
    .addEventListener("click", saveTableNote);
  document
    .getElementById("tableTitle")
    .addEventListener("input", scheduleTableAutosave);

  document.getElementById("exportTableBtn").addEventListener("change", (e) => {
    const type = e.target.value;
    if (!type) return;
    exportCurrentNote(type, false);
    e.target.value = "";
  });

  quill.on("text-change", (delta, oldDelta, source) => {
    if (source !== "user" || isMountingEmbeds) return;
    scheduleAutosave();
  });

  document
    .getElementById("noteTitle")
    .addEventListener("input", scheduleAutosave);
  document
    .getElementById("sketchTitle")
    .addEventListener("input", scheduleSketchAutosave);

  document.getElementById("createNote")?.addEventListener("click", () => {
    notesTypeSelectContainer.hidden = true;
    createNote();
  });
  document.getElementById("createSketch")?.addEventListener("click", () => {
    notesTypeSelectContainer.hidden = true;
    createSketchNote();
  });
  document.getElementById("createTable")?.addEventListener("click", () => {
    notesTypeSelectContainer.hidden = true;
    createTableNote();
  });
  document.getElementById("createFolder")?.addEventListener("click", () => {
    notesTypeSelectContainer.hidden = true;
    openCreateFolderRow();
  });

  attachNoteMenuOutsideClickHandler();

  try {
    const createdFromDraft = await loadCreateNote();
    if (!createdFromDraft) {
      if (forceNew) {
        await createNote();
      } else {
        await loadNotes(noteId);
      }
    }
  } finally {
    setLoading(false);
  }
}

initNotes();

async function loadCreateNote() {
  const savedText = localStorage.getItem("createNote");
  if (!savedText) return false;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return false;

  const { data, error } = await supabase
    .from("personal_notes")
    .insert({
      user_id: user.id,
      title: "Untitled",
      content: sanitizeHTML(savedText),
      note_type: "text",
    })
    .select()
    .single();

  if (error) {
    console.error(error);
    return false;
  }

  actionMsg("Note created", "success");
  document.dispatchEvent(
    new CustomEvent("onboarding:note_created", { detail: { noteId: data.id } }),
  );
  localStorage.removeItem("createNote");

  await loadNotes();
  openNote(data);

  return true;
}

// Fetch user notes and folders
async function fetchUserNotes(userId) {
  const { data: notes, error } = await supabase
    .from("personal_notes")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error(error);
    return null;
  }

  return notes || [];
}

async function fetchUserFolders(userId) {
  const folders = await fetchFolders(userId);

  if (!folders) {
    return [];
  }

  return folders;
}

async function loadNotes(noteId) {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return;

  const [notes, folders] = await Promise.all([
    fetchUserNotes(user.id),
    fetchUserFolders(user.id),
  ]);

  if (notes === null) return;
  savedNoteDetails = notes;
  savedFolders = folders;
  renderNotesList(notes);

  if (noteId) {
    await openNoteById(noteId, user.id);
  } else if (notes.length > 0) {
    openNote(notes[0]);
  } else {
    currentNoteId = null;
    currentNoteType = "text";
    clearAutosaveTimer();
    clearSketchAutosaveTimer();
    clearTableAutosaveTimer();
    currentTables = [];
    lastSavedSnapshot = "";
    setSaveStatus("");
    document.getElementById("linkedTasksChip")?.remove();

    showTextPane();
    const titleInput = document.getElementById("noteTitle");
    if (titleInput) titleInput.value = "";
    if (quill) {
      quill.root.innerHTML = "";
      quill.root.setAttribute("data-placeholder", "Create your first note...");
    }
  }
}

async function refreshSidebarOnly() {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) return;

  const [notes, folders] = await Promise.all([
    fetchUserNotes(user.id),
    fetchUserFolders(user.id),
  ]);

  if (notes === null) return;

  savedNoteDetails = notes;
  savedFolders = folders;
  renderNotesList(notes);
}

// Helpers
function getPlainPreview(html, maxLength = 60) {
  if (!html) return "";
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "…";
}

// Render notes list
function renderNotesList(notes) {
  const notesList = document.getElementById("notesList");
  const notesCount = document.getElementById("notesCount");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (notesCount) notesCount.textContent = notes.length;

  if (notes.length === 0 && savedFolders.length === 0) {
    notesList.innerHTML = `<p class="placeholderText">No notes created yet.</p>`;
    return;
  }

  savedFolders.forEach((folder) => {
    const folderNotes = notes.filter(
      (n) => String(n.folder_id) === String(folder.id),
    );
    const collapsed = !!folderCollapseState[folder.id];

    const folderEl = document.createElement("div");
    folderEl.classList.add("noteFolder");
    if (collapsed) folderEl.classList.add("collapsed");
    folderEl.dataset.folderId = folder.id;

    const header = document.createElement("div");
    header.classList.add("noteFolderHeader");
    header.innerHTML = `
      <svg class="folderChevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M3 7h6l2 2h10v10H3z" />
      </svg>
      <span class="noteFolderName">${folder.name}</span>
      <span class="noteFolderCount">${folderNotes.length}</span>
      <button type="button" class="deleteFolderBtn tooltip" data-title="Delete folder" aria-label="Delete folder">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
      </button>
    `;

    header.addEventListener("click", (e) => {
      if (e.target.closest(".deleteFolderBtn")) return;
      toggleFolderCollapse(folder.id);
    });

    header.querySelector(".deleteFolderBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteFolder(folder.id, folder.name);
    });

    const notesWrap = document.createElement("div");
    notesWrap.classList.add("noteFolderNotes");

    if (folderNotes.length === 0) {
      notesWrap.innerHTML = `<p class="placeholderText folderEmpty">No notes here.</p>`;
    } else {
      folderNotes.forEach((note) => notesWrap.appendChild(buildNoteItem(note)));
    }

    folderEl.append(header, notesWrap);
    notesList.appendChild(folderEl);
  });

  const unfiled = notes.filter((n) => !n.folder_id);
  unfiled.forEach((note) => notesList.appendChild(buildNoteItem(note)));

  highlightActiveNote(currentNoteId);
}

function buildNoteItem(note) {
  const item = document.createElement("div");
  item.classList.add("noteItem");
  if (note.note_type === "sketch") item.classList.add("noteItemSketch");
  if (note.note_type === "table") item.classList.add("noteItemTable");
  if (note.is_public) item.classList.add("noteItemPublic");

  item.dataset.id = note.id;

  const content = document.createElement("div");
  content.classList.add("noteItemContent");

  const typePrefix =
    note.note_type === "sketch"
      ? "🖊 "
      : note.note_type === "table"
        ? "▦ "
        : "";

  //DROPDOWN DIVIDER
  const dropdownDivider = document.createElement("div");
  dropdownDivider.classList.add("dropdown-divider");

  const titleEl = document.createElement("p");
  titleEl.classList.add("noteTitle");
  titleEl.textContent = typePrefix + (note.title || "Untitled");

  const previewEl = document.createElement("span");
  previewEl.classList.add("notePreview");
  previewEl.textContent =
    note.note_type === "sketch"
      ? "Sketch note"
      : note.note_type === "table"
        ? note.table_data?.[0]?.cols?.length
          ? `${note.table_data[0].cols.length} columns · ${note.table_data[0].rows?.length || 0} rows`
          : "Table note"
        : getPlainPreview(note.content);

  const metaEl = document.createElement("span");
  metaEl.classList.add("noteMeta");
  metaEl.textContent = formatDateTimeRelatively(note.updated_at);

  content.append(titleEl, previewEl, metaEl);

  const actionsBtn = document.createElement("button");
  actionsBtn.type = "button";
  actionsBtn.classList.add("noteActionsBtn", "tooltip");
  actionsBtn.setAttribute("data-title", "Note actions");
  actionsBtn.setAttribute("aria-label", "Note actions");
  actionsBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="5" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="12" cy="19" r="1.3" />
    </svg>
  `;

  const actionsMenu = document.createElement("div");
  actionsMenu.classList.add("dropdown", "noteActionsMenu");
  actionsMenu.hidden = true;

  const actionsMenuList = document.createElement("div");
  actionsMenuList.classList.add("dropdown-list");
  actionsMenu.append(actionsMenuList);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.classList.add("btn", "danger", "btn-sm");
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actionsMenu.hidden = true;
    confirmAction("Delete Note", "Delete this note?", [
      { label: "Cancel", type: "cancel" },
      {
        label: "Delete",
        type: "confirm",
        onClick: () => attachDeleteNoteEvent(item, note.id),
      },
    ]);
  });
  actionsMenuList.append(deleteBtn);

  if (note.folder_id) {
    actionsMenuList.append(dropdownDivider);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.classList.add("btn", "btn-sm");
    removeBtn.textContent = "Remove from folder";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      actionsMenu.hidden = true;
      removeNoteFromFolder(note.id);
    });
    actionsMenuList.append(removeBtn);
  } else if (savedFolders.length > 0) {
    actionsMenuList.append(dropdownDivider);

    const label = document.createElement("div");
    label.classList.add("dropdown-sectionLabel");
    label.textContent = "Add to folder";
    actionsMenuList.append(label);

    savedFolders.forEach((folder) => {
      const folderBtn = document.createElement("button");
      folderBtn.type = "button";
      folderBtn.classList.add("btn", "btn-sm");
      folderBtn.textContent = folder.name;
      folderBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        actionsMenu.hidden = true;
        assignNoteToFolder(note.id, folder.id);
      });
      actionsMenuList.append(folderBtn);
    });
  }

  const shareDivider = document.createElement("div");
  shareDivider.classList.add("dropdown-divider");
  actionsMenuList.append(shareDivider);

  const shareActions = note.is_public
    ? [
        ["Copy public link", () => copyShareLink(note)],
        [
          note.show_author ? "Hide my name" : "Show my name",
          () => updateShareFields(note, { show_author: !note.show_author }),
        ],
        ["Regenerate link", () => regenerateShareLink(note)],
        ["Stop sharing", () => disableSharing(note)],
      ]
    : [["Share publicly", () => enableSharing(note)]];

  shareActions.forEach(([label, handler]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("btn", "btn-sm");
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      actionsMenu.hidden = true;
      handler();
    });
    actionsMenuList.append(btn);
  });

  actionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document
      .querySelectorAll(".noteActionsMenu:not([hidden])")
      .forEach((el) => {
        if (el !== actionsMenu) el.hidden = true;
      });
    actionsMenu.hidden = !actionsMenu.hidden;
  });

  item.append(content, actionsBtn, actionsMenu);
  item.onclick = () => openNote(note);

  return item;
}

function attachNoteMenuOutsideClickHandler() {
  if (noteMenuOutsideClickAttached) return;
  document.addEventListener("click", (e) => {
    if (
      e.target.closest(".noteActionsBtn") ||
      e.target.closest(".noteActionsMenu")
    )
      return;
    document
      .querySelectorAll(".noteActionsMenu:not([hidden])")
      .forEach((el) => (el.hidden = true));
  });
  noteMenuOutsideClickAttached = true;
}

function highlightActiveNote(id) {
  document.querySelectorAll(".noteItem").forEach((el) => {
    el.classList.toggle("active", String(el.dataset.id) === String(id));
  });
}

// Pane switching
function showTextPane() {
  document.getElementById("textEditorPane")?.removeAttribute("hidden");
  document.getElementById("sketchEditorPane")?.setAttribute("hidden", "");
  document.getElementById("tableEditorPane")?.setAttribute("hidden", "");
}

function showSketchPane() {
  document.getElementById("sketchEditorPane")?.removeAttribute("hidden");
  document.getElementById("textEditorPane")?.setAttribute("hidden", "");
  document.getElementById("tableEditorPane")?.setAttribute("hidden", "");
  ensureBoardSized();
}

function showTablePane() {
  document.getElementById("tableEditorPane")?.removeAttribute("hidden");
  document.getElementById("textEditorPane")?.setAttribute("hidden", "");
  document.getElementById("sketchEditorPane")?.setAttribute("hidden", "");
}

// Open note in editor
async function openNoteById(noteId, userId) {
  const noteData = await fetchNoteById(noteId, userId);
  openNote(noteData);
}

function openNote(note) {
  clearAutosaveTimer();
  clearSketchAutosaveTimer();
  clearTableAutosaveTimer();
  currentNoteId = note.id;
  currentNoteType = note.note_type || "text";
  highlightActiveNote(note.id);

  if (currentNoteType === "sketch") {
    showSketchPane();
    document.getElementById("sketchTitle").value =
      note.title || "Untitled Sketch";
    undoStack = [];
    loadImageOntoBoard(note.canvas_data);
    lastSavedSketchSnapshot = (note.title || "") + (note.canvas_data || "");
    setSketchSaveStatus("");
    setSketchTool("pen");
  } else if (currentNoteType === "table") {
    showTablePane();
    const title = note.title || "Untitled Table";
    currentTables =
      Array.isArray(note.table_data) && note.table_data.length
        ? note.table_data
        : [createTable("Table 1")];
    document.getElementById("tableTitle").value = title;
    const wrap = document.getElementById("standaloneTableWrap");
    renderTableWidget(wrap, currentTables[0], {
      allowNameEdit: false,
      onChange: () => scheduleTableAutosave(),
    });
    lastSavedTableSnapshot = title + JSON.stringify(currentTables);
    setTableSaveStatus("");
  } else {
    showTextPane();
    const title = note.title || "Untitled";
    const content = sanitizeHTML(note.content || "");
    currentTables = Array.isArray(note.table_data) ? note.table_data : [];

    document.getElementById("noteTitle").value = title;
    quill.root.innerHTML = content || "";

    quill.root
      .querySelectorAll(".ql-table-embed[data-mounted]")
      .forEach((n) => n.removeAttribute("data-mounted"));
    quill.update("silent");

    requestAnimationFrame(() => mountTableEmbeds(quill.root));

    lastSavedSnapshot = title + content + JSON.stringify(currentTables);
    setSaveStatus("");
  }

  fetchLinkedTasks(note.id).then(renderLinkedTasksChip);
}

// Create note (text)
async function createNote() {
  setLoading(true);

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("personal_notes")
      .insert({
        user_id: user.id,
        title: "Untitled",
        content: "",
        note_type: "text",
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      actionMsg("Failed to create note.", "error");
      return;
    }

    await loadNotes();
    openNote(data);

    document.dispatchEvent(
      new CustomEvent("onboarding:note_created", {
        detail: { noteId: data.id },
      }),
    );
    actionMsg("Note created. Start typing!", "success");
  } finally {
    setLoading(false);
  }
}

// Create note (sketch)
async function createSketchNote() {
  setLoading(true);

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("personal_notes")
      .insert({
        user_id: user.id,
        title: "Untitled Sketch",
        content: "",
        note_type: "sketch",
        canvas_data: null,
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      actionMsg("Failed to create sketch.", "error");
      return;
    }

    await loadNotes();
    openNote(data);

    document.dispatchEvent(
      new CustomEvent("onboarding:note_created", {
        detail: { noteId: data.id },
      }),
    );
    actionMsg("Sketch created!", "success");
  } finally {
    setLoading(false);
  }
}

// Create note (standalone table)
async function createTableNote() {
  setLoading(true);

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("personal_notes")
      .insert({
        user_id: user.id,
        title: "Untitled Table",
        content: "",
        note_type: "table",
        table_data: [createTable("Table 1")],
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      actionMsg("Failed to create table.", "error");
      return;
    }

    await loadNotes();
    openNote(data);

    document.dispatchEvent(
      new CustomEvent("onboarding:note_created", {
        detail: { noteId: data.id },
      }),
    );
    actionMsg("Table created!", "success");
  } finally {
    setLoading(false);
  }
}

// Save note (standalone table)
async function saveTableNote() {
  if (isSavingTableNote) return;

  const saveBtn = document.getElementById("saveTableBtn");
  isSavingTableNote = true;
  setButtonLoading(saveBtn, true);
  clearTableAutosaveTimer();

  const title = document.getElementById("tableTitle").value;

  try {
    const { error } = await supabase
      .from("personal_notes")
      .update({
        title: title || "Untitled Table",
        table_data: currentTables,
        updated_at: new Date(),
      })
      .eq("id", currentNoteId);

    if (error) {
      console.error(error);
      actionMsg("Failed to save table.", "error");
      return;
    }

    lastSavedTableSnapshot = title + JSON.stringify(currentTables);
    setTableSaveStatus("Saved");

    await loadNotes();
    actionMsg("Table saved successfully!", "success");
  } finally {
    isSavingTableNote = false;
    setButtonLoading(saveBtn, false);
  }
}

// Inline tables inside text notes
function insertInlineTable() {
  if (!quill) return;
  const range = quill.getSelection(true) || {
    index: quill.getLength(),
    length: 0,
  };

  const table = createTable("Table " + (currentTables.length + 1));
  currentTables.push(table);

  quill.insertEmbed(range.index, "table-embed", { id: table.id }, "user");
  quill.setSelection(range.index + 1, 0, "user");

  mountTableEmbeds(quill.root);
  scheduleAutosave();
}

function mountTableEmbeds(root) {
  isMountingEmbeds = true;

  const nodes = root.querySelectorAll(".ql-table-embed");

  nodes.forEach((node) => {
    const tableId = node.getAttribute("data-table-id");
    if (!tableId) {
      console.warn("table-embed missing data-table-id", node);
      return;
    }

    let table = currentTables.find((t) => String(t.id) === String(tableId));

    if (!table) {
      table = createTable("Table (recovered)");
      table.id = tableId;
      currentTables.push(table);
    }

    node.removeAttribute("data-mounted");
    node.setAttribute("data-mounted", "1");

    renderTableWidget(node, table, {
      onDelete: () => {
        currentTables = currentTables.filter(
          (t) => String(t.id) !== String(tableId),
        );
        const blot = Quill.find(node);
        if (blot) {
          const index = quill.getIndex(blot);
          quill.deleteText(index, 1, "user");
        }
        scheduleAutosave();
      },
      onChange: () => scheduleAutosave(),
    });
  });

  isMountingEmbeds = false;
}

function getSavableContentHTML() {
  const clone = quill.root.cloneNode(true);
  clone.querySelectorAll(".ql-table-embed").forEach((node) => {
    const id = node.getAttribute("data-table-id");
    node.innerHTML = "";
    node.setAttribute("data-table-id", id);
    node.removeAttribute("data-mounted");
  });
  return clone.innerHTML;
}

// Save note (text)
async function persistNote(title, content, tableData = []) {
  if (!currentNoteId) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { error: new Error("Not authenticated") };

    const { data, error } = await supabase
      .from("personal_notes")
      .insert({
        user_id: user.id,
        title: title || "Untitled",
        content,
        note_type: "text",
        table_data: tableData,
      })
      .select()
      .single();

    if (error) return { error };

    currentNoteId = data.id;
    document.dispatchEvent(
      new CustomEvent("onboarding:note_created", {
        detail: { noteId: data.id },
      }),
    );

    return { data, created: true };
  }

  const { error } = await supabase
    .from("personal_notes")
    .update({ title, content, table_data: tableData, updated_at: new Date() })
    .eq("id", currentNoteId);

  if (error) return { error };
  return { created: false };
}

function updateSidebarEntry(id, title, content = null) {
  if (!id) return;

  const item = document.querySelector(`.noteItem[data-id="${id}"]`);
  if (!item) return;

  const titleEl = item.querySelector(".noteTitle");
  if (titleEl) {
    const isSketch = item.classList.contains("noteItemSketch");
    const isTable = item.classList.contains("noteItemTable");
    const prefix = isSketch ? "🖊 " : isTable ? "▦ " : "";
    titleEl.textContent = prefix + (title || "Untitled");
  }

  if (content !== null) {
    const previewEl = item.querySelector(".notePreview");
    if (previewEl) previewEl.textContent = getPlainPreview(content);
  }

  const metaEl = item.querySelector(".noteMeta");
  if (metaEl) metaEl.textContent = "Just now";

  const cached = savedNoteDetails.find(
    (note) => String(note.id) === String(id),
  );
  if (cached) {
    cached.title = title;
    if (content !== null) cached.content = content;
    cached.updated_at = new Date().toISOString();
  }
}

async function saveNote() {
  if (isSaving) return;

  const saveBtn = document.getElementById("saveNoteBtn");
  isSaving = true;
  setButtonLoading(saveBtn, true);
  clearAutosaveTimer();

  const title = document.getElementById("noteTitle").value;
  const content = sanitizeHTML(getSavableContentHTML());

  try {
    const { error } = await persistNote(title, content, currentTables);

    if (error) {
      console.error(error);
      actionMsg("Failed to save note.", "error");
      return;
    }

    lastSavedSnapshot = title + content + JSON.stringify(currentTables);
    setSaveStatus("Saved");

    await loadNotes();
    actionMsg("Note saved successfully!", "success");
  } finally {
    isSaving = false;
    setButtonLoading(saveBtn, false);
  }
}

// Sketch board
function initSketchBoard() {
  board = document.getElementById("board");
  if (!board) return;
  context = board.getContext("2d");

  const colorPicker = document.getElementById("color-picker");
  const brushSize = document.getElementById("brush-size");
  const penToolBtn = document.getElementById("pen-tool-button");
  const eraserToolBtn = document.getElementById("eraser-tool-button");
  const undoBtn = document.getElementById("undo-button");
  const clearBtn = document.getElementById("clear-button");
  const fillBtn = document.getElementById("fill-button");
  const downloadBtn = document.getElementById("download-button");

  board.style.touchAction = "none";

  board.addEventListener("pointerdown", (e) => {
    if (sketchTool === "text") {
      placeSketchText(e);
      return;
    }
    pushUndoSnapshot();
    isdrawing = true;
  });

  board.addEventListener("pointerup", () => {
    if (!isdrawing) return;
    isdrawing = false;
    context.beginPath();
    context.globalCompositeOperation = "source-over";
    scheduleSketchAutosave();
  });

  board.addEventListener("pointerout", () => (isdrawing = false));
  board.addEventListener("pointermove", drawOnBoard);

  clearBtn.addEventListener("click", () => {
    pushUndoSnapshot();
    clearBoard();
    scheduleSketchAutosave();
  });

  fillBtn.addEventListener("click", () => {
    pushUndoSnapshot();
    fillBoard();
    scheduleSketchAutosave();
  });

  downloadBtn.addEventListener("click", downloadBoard);
  undoBtn.addEventListener("click", undoSketch);

  penToolBtn.addEventListener("click", () => setSketchTool("pen"));
  eraserToolBtn.addEventListener("click", () =>
    setSketchTool(sketchTool === "eraser" ? "pen" : "eraser"),
  );

  function drawOnBoard(e) {
    if (!isdrawing) return;

    const [x, y] = getBoardPos(e);

    context.lineWidth =
      sketchTool === "eraser" ? brushSize.value * 3 : brushSize.value;
    context.lineCap = "round";
    context.globalCompositeOperation =
      sketchTool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = colorPicker.value;

    context.lineTo(x, y);
    context.stroke();
    context.beginPath();
    context.moveTo(x, y);
  }

  setSketchTool("pen");
}

function getBoardPos(e) {
  const rect = board.getBoundingClientRect();
  const scaleX = board.width / rect.width;
  const scaleY = board.height / rect.height;
  return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
}

function ensureBoardSized() {
  if (!board) return;
  if (board.width === BOARD_WIDTH && board.height === BOARD_HEIGHT) return;
  board.width = BOARD_WIDTH;
  board.height = BOARD_HEIGHT;
}

function clearBoard() {
  context.clearRect(0, 0, board.width, board.height);
}

function fillBoard() {
  const colorPicker = document.getElementById("color-picker");
  context.fillStyle = colorPicker.value;
  context.fillRect(0, 0, board.width, board.height);
}

function downloadBoard() {
  const title = document.getElementById("sketchTitle")?.value || "sketch";
  const safeTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const imageLink = document.createElement("a");
  imageLink.download = `${safeTitle || "sketch"}.png`;
  imageLink.href = board.toDataURL("image/png");
  imageLink.click();
}

function setSketchTool(tool) {
  sketchTool = tool;
  document
    .getElementById("pen-tool-button")
    ?.classList.toggle("active", tool === "pen");
  document
    .getElementById("eraser-tool-button")
    ?.classList.toggle("active", tool === "eraser");
  board.style.cursor =
    tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair";
}

function placeSketchText(e) {
  const rect = board.getBoundingClientRect();
  const displayX = e.clientX - rect.left;
  const displayY = e.clientY - rect.top;
  const [boardX, boardY] = getBoardPos(e);
  const colorPicker = document.getElementById("color-picker");

  const editable = document.createElement("div");
  editable.contentEditable = "true";
  editable.className = "sketchTextInput";
  editable.style.position = "absolute";
  editable.style.left = `${displayX}px`;
  editable.style.top = `${displayY}px`;
  editable.style.color = colorPicker.value;
  editable.style.font = "20px sans-serif";
  editable.style.minWidth = "20px";
  editable.style.outline = "1px dashed var(--accent, #3b82f6)";
  editable.style.background = "transparent";
  board.parentElement.appendChild(editable);
  editable.focus();

  const commit = () => {
    const content = editable.textContent.trim();
    editable.remove();
    if (!content) return;
    pushUndoSnapshot();
    const scale = board.width / rect.width;
    context.fillStyle = colorPicker.value;
    context.font = `${20 * scale}px sans-serif`;
    context.textBaseline = "top";
    context.fillText(content, boardX, boardY);
    scheduleSketchAutosave();
  };

  editable.addEventListener("blur", commit, { once: true });
  editable.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      editable.blur();
    }
  });
}

function pushUndoSnapshot() {
  if (!board.width || !board.height) return;
  undoStack.push(board.toDataURL("image/png"));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function undoSketch() {
  const previous = undoStack.pop();
  if (!previous) return;
  const img = new Image();
  img.onload = () => {
    context.clearRect(0, 0, board.width, board.height);
    context.drawImage(img, 0, 0);
    scheduleSketchAutosave();
  };
  img.src = previous;
}

function loadImageOntoBoard(dataUrl) {
  ensureBoardSized();
  if (!context) return;
  context.clearRect(0, 0, board.width, board.height);
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => context.drawImage(img, 0, 0);
  img.src = dataUrl;
}

// Export: HTML to Markdown
function htmlToMarkdown(html) {
  const container = document.createElement("div");
  container.innerHTML = html;

  function walk(node) {
    let out = "";

    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
        return;
      }

      if (child.nodeType !== Node.ELEMENT_NODE) return;

      const tag = child.tagName.toLowerCase();
      const inner = walk(child);

      switch (tag) {
        case "h1":
          out += `\n# ${inner.trim()}\n\n`;
          break;
        case "h2":
          out += `\n## ${inner.trim()}\n\n`;
          break;
        case "h3":
          out += `\n### ${inner.trim()}\n\n`;
          break;
        case "h4":
          out += `\n#### ${inner.trim()}\n\n`;
          break;
        case "h5":
          out += `\n##### ${inner.trim()}\n\n`;
          break;
        case "h6":
          out += `\n###### ${inner.trim()}\n\n`;
          break;
        case "strong":
        case "b":
          out += `**${inner}**`;
          break;
        case "em":
        case "i":
          out += `*${inner}*`;
          break;
        case "u":
          out += `_${inner}_`;
          break;
        case "s":
        case "strike":
          out += `~~${inner}~~`;
          break;
        case "a":
          out += `[${inner}](${child.getAttribute("href") || ""})`;
          break;
        case "code":
          out += `\`${inner}\``;
          break;
        case "pre":
          out += `\n\`\`\`\n${inner.trim()}\n\`\`\`\n\n`;
          break;
        case "blockquote":
          out += `\n> ${inner.trim()}\n\n`;
          break;
        case "li": {
          const parent = child.parentElement;
          const isOrdered = parent && parent.tagName.toLowerCase() === "ol";

          if (child.dataset.list === "checked")
            out += `- [x] ${inner.trim()}\n`;
          else if (child.dataset.list === "unchecked")
            out += `- [ ] ${inner.trim()}\n`;
          else if (isOrdered) out += `1. ${inner.trim()}\n`;
          else out += `- ${inner.trim()}\n`;
          break;
        }
        case "ol":
        case "ul":
          out += `\n${inner}\n`;
          break;
        case "p":
          out += `${inner.trim()}\n\n`;
          break;
        case "br":
          out += `\n`;
          break;
        case "img":
          out += `![](${child.getAttribute("src") || ""})`;
          break;
        default:
          out += inner;
      }
    });

    return out;
  }

  return walk(container)
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function exportFile(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}

function resolveInlineTablesHTML(rawHtml) {
  const container = document.createElement("div");
  container.innerHTML = rawHtml;

  container.querySelectorAll(".ql-table-embed").forEach((node) => {
    const tableId = node.getAttribute("data-table-id");
    const table = currentTables.find((t) => String(t.id) === String(tableId));
    const wrapper = document.createElement("div");
    wrapper.innerHTML = table ? renderTableToHTML(table) : "";
    node.replaceWith(wrapper);
  });

  return container.innerHTML;
}

// Folders
function openCreateFolderRow() {
  if (document.getElementById("newFolderModal")) return;

  const notesList = document.getElementById("notesList");
  const row = document.createElement("div");
  row.id = "newFolderModal";
  row.classList.add("newFolderModal");
  row.innerHTML = `
    <input type="text" id="newFolderNameInput" class="inputField" placeholder="Folder name" />
    <button type="button" id="confirmCreateFolderBtn" class="btn-sm btn">Create</button>
    <button type="button" id="cancelCreateFolderBtn" class="btn-sm btn btn-secondary">Cancel</button>
  `;
  notesList.prepend(row);

  const input = row.querySelector("#newFolderNameInput");
  input.focus();

  const cleanup = () => row.remove();

  row
    .querySelector("#cancelCreateFolderBtn")
    .addEventListener("click", cleanup);

  const submit = () => {
    const name = input.value.trim();
    if (!name) return cleanup();
    cleanup();
    createFolder(name);
  };

  row
    .querySelector("#confirmCreateFolderBtn")
    .addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") cleanup();
  });
}

async function createFolder(name) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data, error } = await supabase
    .from("note_folders")
    .insert({ user_id: user.id, name })
    .select()
    .single();

  if (error) {
    console.error(error);
    actionMsg("Failed to create folder.", "error");
    return;
  }

  savedFolders.push(data);
  renderNotesList(savedNoteDetails);
  actionMsg("Folder created", "success");
}

function confirmDeleteFolder(folderId, folderName) {
  confirmAction(
    "Delete Folder",
    `Delete "${folderName}"? Notes inside won't be deleted, they'll just be removed from this folder.`,
    [
      { label: "Cancel", type: "cancel" },
      {
        label: "Delete",
        type: "confirm",
        onClick: () => deleteFolder(folderId),
      },
    ],
  );
}

async function deleteFolder(folderId) {
  const { error: detachError } = await supabase
    .from("personal_notes")
    .update({ folder_id: null })
    .eq("folder_id", folderId);

  if (detachError) {
    console.error(detachError);
    actionMsg("Failed to remove notes from folder.", "error");
    return;
  }

  const { error } = await supabase
    .from("note_folders")
    .delete()
    .eq("id", folderId);

  if (error) {
    console.error(error);
    actionMsg("Failed to delete folder.", "error");
    return;
  }

  savedFolders = savedFolders.filter((f) => f.id !== folderId);
  savedNoteDetails.forEach((n) => {
    if (n.folder_id === folderId) n.folder_id = null;
  });
  delete folderCollapseState[folderId];
  persistFolderCollapseState();
  renderNotesList(savedNoteDetails);
  actionMsg("Folder deleted", "success");
}

async function assignNoteToFolder(noteId, folderId) {
  const { error } = await supabase
    .from("personal_notes")
    .update({ folder_id: folderId })
    .eq("id", noteId);

  if (error) {
    console.error(error);
    actionMsg("Failed to add note to folder.", "error");
    return;
  }

  const note = savedNoteDetails.find((n) => String(n.id) === String(noteId));
  if (note) note.folder_id = folderId;
  renderNotesList(savedNoteDetails);
  actionMsg("Note added to folder", "success");
}

async function removeNoteFromFolder(noteId) {
  const { error } = await supabase
    .from("personal_notes")
    .update({ folder_id: null })
    .eq("id", noteId);

  if (error) {
    console.error(error);
    actionMsg("Failed to remove note from folder.", "error");
    return;
  }

  const note = savedNoteDetails.find((n) => String(n.id) === String(noteId));
  if (note) note.folder_id = null;
  renderNotesList(savedNoteDetails);
  actionMsg("Note removed from folder", "success");
}

function toggleFolderCollapse(folderId) {
  folderCollapseState[folderId] = !folderCollapseState[folderId];
  persistFolderCollapseState();
  renderNotesList(savedNoteDetails);
}

// Export: shared html/pdf renderer
async function exportRenderedNote(type, title, safeTitle, htmlContent) {
  const planName = (sessionState?.plan?.name || "").toLowerCase();

  if (type === "html") {
    if (planName === "free") {
      await openUpgradeModal("exportHtml");
      return false;
    }

    const fullHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/quill@1.3.7/dist/quill.snow.css" rel="stylesheet">
  <style>
    body { font-family: Arial, sans-serif; padding: 40px; }
    .ql-editor { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="ql-editor">${htmlContent}</div>
</body>
</html>`;
    exportFile(`${safeTitle}.html`, fullHTML, "text/html");
    return true;
  }

  if (type === "pdf") {
    if (planName === "free") {
      await openUpgradeModal("exportPdf");
      return false;
    }

    const cleanHTML = htmlContent.replace(/&nbsp;/g, " ");
    const wrapper = document.createElement("div");
    wrapper.style.width = "210mm";
    wrapper.style.padding = "20mm";
    wrapper.style.background = "#fff";
    wrapper.style.fontFamily = "Arial, sans-serif";
    wrapper.style.fontSize = "12px";
    wrapper.style.lineHeight = "1.6";

    wrapper.innerHTML = `
      <style>
        .pdf-container, .pdf-container *, .pdf-container p, .pdf-container span {
          color: #000000 !important;
          -webkit-text-fill-color: #000000 !important;
        }
        .pdf-container h1 {
          text-align: center;
          margin-bottom: 20px;
          color: #000000 !important;
        }
      </style>
      <div class="pdf-container">
        <h1>${title}</h1>
        <div>${cleanHTML}</div>
      </div>
    `;

    document.body.appendChild(wrapper);

    setTimeout(() => {
      html2pdf()
        .set({
          margin: 0,
          filename: `${safeTitle}.pdf`,
          html2canvas: { scale: 2, useCORS: true, logging: false },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"] },
        })
        .from(wrapper)
        .save()
        .catch((err) => {
          console.error(err);
          actionMsg("Failed to export PDF.", "error");
        })
        .finally(() => {
          if (wrapper.parentNode) document.body.removeChild(wrapper);
        });
    }, 300);

    return true;
  }

  return false;
}

// Public sharing
const shareUrl = (note) => `${location.origin}/pages/share?id=${note.share_id}`;

async function updateShareFields(note, fields) {
  const { data, error } = await supabase
    .from("personal_notes")
    .update(fields)
    .eq("id", note.id)
    .select("is_public, share_id, show_author")
    .single();

  if (error) {
    console.error(error);
    actionMsg("Sharing update failed.", "error");
    return false;
  }

  Object.assign(note, data);
  renderNotesList(savedNoteDetails);
  return true;
}

async function copyShareLink(note) {
  try {
    await navigator.clipboard.writeText(shareUrl(note));
    actionMsg("Link copied", "success");
  } catch {
    prompt("Copy this link:", shareUrl(note));
  }
}

function enableSharing(note) {
  confirmAction(
    "Share note publicly",
    "Anyone with the link can view this note without logging in, and links can be forwarded. You can stop sharing or regenerate the link at any time.",
    [
      { label: "Cancel", type: "cancel" },
      {
        label: "Make public",
        type: "confirm",
        onClick: async () => {
          if (await updateShareFields(note, { is_public: true })) {
            copyShareLink(note);
          }
        },
      },
    ],
  );
}

async function disableSharing(note) {
  if (await updateShareFields(note, { is_public: false, show_author: false })) {
    actionMsg("Sharing turned off", "success");
  }
}

function regenerateShareLink(note) {
  confirmAction(
    "Regenerate link",
    "The old link will stop working. Anyone who has it will lose access.",
    [
      { label: "Cancel", type: "cancel" },
      {
        label: "Regenerate",
        type: "confirm",
        onClick: async () => {
          if (
            await updateShareFields(note, { share_id: crypto.randomUUID() })
          ) {
            copyShareLink(note);
          }
        },
      },
    ],
  );
}

async function exportCurrentNote(type, skipTableWarning = false) {
  setLoading(true);

  if (!currentNoteId) {
    setLoading(false);
    actionMsg("Save the note before exporting.", "error");
    return;
  }

  const hasInlineTables =
    currentNoteType === "text" && currentTables.length > 0;
  const unsupportedForTables =
    type === "docx" || type === "txt" || type === "md";

  if (hasInlineTables && unsupportedForTables && !skipTableWarning) {
    setLoading(false);
    confirmAction(
      "Tables won't be exported",
      "This note has one or more tables. DOCX, TXT, and Markdown exports don't support tables yet, it'll be left out of the file. Export anyway?",
      [
        { label: "Cancel", type: "cancel" },
        {
          label: "Export anyway",
          type: "confirm",
          onClick: () => exportCurrentNote(type, true),
        },
      ],
    );
    return;
  }

  if (currentNoteType === "table") {
    if (type !== "html" && type !== "pdf") {
      setLoading(false);
      actionMsg("Table notes currently export as PDF or HTML only.", "error");
      return;
    }
    const title =
      document.getElementById("tableTitle").value || "Untitled Table";
    const safeTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const htmlContent = renderTableToHTML(currentTables[0]);
    const didExport = await exportRenderedNote(
      type,
      title,
      safeTitle,
      htmlContent,
    );
    setLoading(false);
    if (didExport) actionMsg("Note exported!", "success");
    return;
  }

  const title = document.getElementById("noteTitle").value || "Untitled";
  const safeTitle = title.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const htmlContent = quill.root.innerHTML;
  const plainText = quill.getText();

  const planName = (sessionState?.plan?.name || "").toLowerCase();

  let didExport = false;

  switch (type) {
    case "html": {
      const resolvedHTML = resolveInlineTablesHTML(htmlContent);
      didExport = await exportRenderedNote(
        type,
        title,
        safeTitle,
        resolvedHTML,
      );
      if (!didExport) {
        setLoading(false);
        return;
      }
      break;
    }

    case "txt":
      exportFile(`${safeTitle}.txt`, plainText, "text/plain");
      didExport = true;
      break;

    case "md": {
      const markdown = htmlToMarkdown(htmlContent);
      exportFile(`${safeTitle}.md`, markdown, "text/markdown");
      didExport = true;
      break;
    }

    case "docx": {
      if (planName === "free") {
        await openUpgradeModal("exportDocx");
        setLoading(false);
        return;
      }
      const { Document, Packer, Paragraph } = window.docx;
      const doc = new Document({
        sections: [
          { properties: {}, children: [new Paragraph({ text: plainText })] },
        ],
      });
      Packer.toBlob(doc).then((blob) => saveAs(blob, `${safeTitle}.docx`));
      didExport = true;
      break;
    }

    case "pdf": {
      const resolvedHTML = resolveInlineTablesHTML(htmlContent);
      didExport = await exportRenderedNote(
        type,
        title,
        safeTitle,
        resolvedHTML,
      );
      if (!didExport) {
        setLoading(false);
        return;
      }
      break;
    }

    default:
      setLoading(false);
      actionMsg("Invalid export type.", "error");
      return;
  }

  if (didExport) {
    setLoading(false);
    actionMsg("Note exported!", "success");
  }
}

async function fetchLinkedTasks(noteId) {
  const { data, error } = await supabase
    .from("personal_tasks")
    .select("id, name, is_completed")
    .eq("linked_note_id", noteId);

  if (error) {
    console.error(error);
    return [];
  }

  return data || [];
}

function renderLinkedTasksChip(tasks) {
  const existing = document.getElementById("linkedTasksChip");
  if (existing) existing.remove();

  if (!tasks.length) return;

  const chip = document.createElement("div");
  chip.id = "linkedTasksChip";
  chip.classList.add("linkedTasksChip");
  chip.title = tasks.map((t) => t.name).join(", ");
  chip.textContent = `🔗 ${tasks.length} linked task${tasks.length > 1 ? "s" : ""}`;

  const activePane =
    currentNoteType === "sketch"
      ? document.querySelector("#sketchEditorPane .editorTop")
      : document.querySelector("#textEditorPane .editorTop");
  activePane?.appendChild(chip);
}

// Delete
async function attachDeleteNoteEvent(noteToDelete, id) {
  if (String(id) === String(currentNoteId)) {
    clearAutosaveTimer();
    clearSketchAutosaveTimer();
    clearTableAutosaveTimer();
  }

  const { error } = await supabase.from("personal_notes").delete().eq("id", id);

  if (error) {
    setLoading(false);
    console.error(error);
    actionMsg(error.message, "error");
    return;
  }

  const index = savedNoteDetails.findIndex(
    (note) => String(note.id) === String(id),
  );
  if (index !== -1) savedNoteDetails.splice(index, 1);

  noteToDelete.classList.add("removing");

  await loadNotes();

  setTimeout(() => noteToDelete.remove(), 400);

  actionMsg("Note deleted", "success");
}

function attachExpandToggle(btnId, paneId) {
  const btn = document.getElementById(btnId);
  const pane = document.getElementById(paneId);
  if (!btn || !pane) return;

  btn.addEventListener("click", () => {
    const first = pane.getBoundingClientRect();
    pane.classList.toggle("expanded");
    const last = pane.getBoundingClientRect();

    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;

    pane.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: "none" },
      ],
      { duration: 400, easing: "ease" },
    );
  });
}
