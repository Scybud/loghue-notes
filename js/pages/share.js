import { supabase } from "../supabase.js";
import DOMPurify from "https://esm.sh/dompurify@3";
import { renderTableToHTML } from "https://app.loghue.com/js/components/tables/tableWidget.js";

const root = document.getElementById("shareRoot");
const id = new URLSearchParams(location.search).get("id");

const clean = (html) => DOMPurify.sanitize(html);

const notFound = () => {
  root.innerHTML = `<p class="shareMsg">This note is not available.</p>`;
};

function renderBody(note) {
  const body = document.createElement("div");
  const tables = Array.isArray(note.table_data) ? note.table_data : [];

  if (note.note_type === "sketch") {
    if (note.canvas_data?.startsWith("data:image/")) {
      const img = new Image();
      img.className = "shareSketch";
      img.alt = note.title || "Sketch";
      img.onerror = () => {
        body.innerHTML = `<p class="shareMsg">The sketch could not be loaded.</p>`;
      };
      img.src = note.canvas_data;
      body.append(img);
    } else {
      body.innerHTML = `<p class="shareMsg">This sketch has no saved drawing.</p>`;
    }
  } else if (note.note_type === "table") {
    body.className = "shareTableWrap";
    body.innerHTML = tables[0] ? clean(renderTableToHTML(tables[0])) : "";
  } else {
    // Sanitize first, then swap inline table embeds for real tables
    const box = document.createElement("div");
    box.innerHTML = clean(note.content || "");
    box.querySelectorAll(".ql-table-embed").forEach((node) => {
      const table = tables.find(
        (t) => String(t.id) === node.getAttribute("data-table-id"),
      );
      const wrap = document.createElement("div");
      wrap.className = "shareTableWrap";
      wrap.innerHTML = table ? clean(renderTableToHTML(table)) : "";
      node.replaceWith(wrap);
    });
    body.className = "ql-editor";
    body.append(...box.childNodes);
  }

  return body;
}

async function init() {
  if (!id) return notFound();

  const { data, error } = await supabase.rpc("get_shared_note", {
    p_share_id: id,
  });
  const note = data?.[0];
  if (error || !note) return notFound();

  // Private: only the owner passes, straight to their notes page
  if (!note.is_public) {
    if (note.is_owner)
      return location.replace(`/notes/editor?note=${note.id}`);
    return notFound();
  }

  document.title = note.title || "Untitled";

  const h1 = document.createElement("h1");
  h1.textContent = note.title || "Untitled";
  const parts = [h1];

  if (note.author) {
    const by = document.createElement("p");
    by.className = "shareAuthor";
    by.textContent = `By ${note.author}`;
    parts.push(by);
  }

  parts.push(renderBody(note));
  root.replaceChildren(...parts);
}

init();
