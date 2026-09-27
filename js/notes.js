import { supabase } from "./supabase.js";
import {
  confirmAction,
  actionMsg,
} from "https://app.loghue.com/js/utils/modals.js";
import {
  fetchUserNotes as fetchNotesFromDb,
  fetchUserFolders as fetchFoldersFromDb,
} from "./data/notesDb.js";
import { formatDateTimeRelatively } from "https://app.loghue.com/js/utils/time.js";
import { createTable } from "https://app.loghue.com/js/components/tables/tableWidget.js";

let savedNoteDetails = [];
let savedFolders = [];
let folderCollapseState = loadFolderCollapseState();
let isLoading = false;
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
  document
    .querySelector(".notesContainer")
    ?.classList.toggle("isLoading", state);
}

// Fetch notes and folders
async function fetchUserNotes(userId) {
  const notes = await fetchNotesFromDb(userId);
  return notes || [];
}

async function fetchUserFolders(userId) {
  const folders = await fetchFoldersFromDb(userId);
  return folders || [];
}

async function loadNotes() {
  setLoading(true);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    setLoading(false);
    return;
  }

  const [notes, folders] = await Promise.all([
    fetchUserNotes(user.id),
    fetchUserFolders(user.id),
  ]);

  savedNoteDetails = notes;
  savedFolders = folders;
  renderNotesList(notes);
  setLoading(false);
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
        onClick: () => deleteNote(item, note.id),
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
  item.onclick = () => openNoteInEditor(note.id);

  return item;
}

// Navigation to editor page, replaces the old inline openNote()
function openNoteInEditor(noteId) {
  window.open(`/notes/editor?note=${noteId}`, "_blank");
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

// Create note (text/sketch/table), each inserts then hands off to the editor page
async function createNote() {
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

  document.dispatchEvent(
    new CustomEvent("onboarding:note_created", { detail: { noteId: data.id } }),
  );
  openNoteInEditor(data.id);
}

async function createSketchNote() {
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

  document.dispatchEvent(
    new CustomEvent("onboarding:note_created", { detail: { noteId: data.id } }),
  );
  openNoteInEditor(data.id);
}

async function createTableNote() {
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

  document.dispatchEvent(
    new CustomEvent("onboarding:note_created", { detail: { noteId: data.id } }),
  );
  openNoteInEditor(data.id);
}

// Delete
async function deleteNote(itemEl, id) {
  const { error } = await supabase.from("personal_notes").delete().eq("id", id);

  if (error) {
    console.error(error);
    actionMsg(error.message, "error");
    return;
  }

  const index = savedNoteDetails.findIndex(
    (note) => String(note.id) === String(id),
  );
  if (index !== -1) savedNoteDetails.splice(index, 1);

  itemEl.classList.add("removing");
  setTimeout(() => itemEl.remove(), 400);
  renderNotesList(savedNoteDetails);
  actionMsg("Note deleted", "success");
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

// Init
function initNotesList() {
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
  loadNotes();
}

initNotesList();
