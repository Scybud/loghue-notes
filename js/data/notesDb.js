import { supabase } from "../supabase.js";
import { actionMsg } from "https://app.loghue.com/js/utils/modals.js";

export async function fetchUserNotes(userId) {
  const { data: notes, error } = await supabase
    .from("personal_notes")
    .select("id, title")
    .eq("user_id", userId);

  if (error) {
    actionMsg("Error loading notes", "error");
    return;
  }

  return notes;
}

export async function fetchUserFolders(userId) {
  const { data: folders, error } = await supabase
    .from("note_folders")
    .select("id, name, user_id")
    .eq("user_id", userId);

  if (error) {
    actionMsg("Error loading folders", "error");
    return;
  }

  return folders;
}

export async function fetchNoteById(noteId, userId) {
  const { data: note, error } = await supabase
    .from("personal_notes")
    .select("id, title, content, note_type, canvas_data, table_data")
    .eq("user_id", userId)
    .eq("id", noteId)
    .single();

  if (error) {
    console.log(error);
    actionMsg("Error loading notes", "error");
    return;
  }

  return note;
}
