const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const FIELD_TYPES = ['text', 'textarea', 'email', 'select', 'checkbox', 'file'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS forms (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  accent_color    TEXT NOT NULL DEFAULT '#4f46e5',
  submit_label    TEXT NOT NULL DEFAULT 'Submit',
  success_message TEXT NOT NULL DEFAULT 'Thanks! Your response was recorded.',
  notify_email    INTEGER NOT NULL DEFAULT 0,
  webhook_url     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS fields (
  id          INTEGER PRIMARY KEY,
  form_id     INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  label       TEXT NOT NULL,
  help_text   TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL DEFAULT '',  -- one option per line (select / checkbox group)
  required    INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fields_form ON fields(form_id, position);

CREATE TABLE IF NOT EXISTS responses (
  id          INTEGER PRIMARY KEY,
  form_id     INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,             -- JSON object keyed by field id
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS responses_form ON responses(form_id, created_at);
`;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'forms.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return createRepo(db);
}

function parseOptions(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function hydrateField(row) {
  return row && { ...row, required: !!row.required, optionList: parseOptions(row.options) };
}

function hydrateForm(row) {
  return row && { ...row, notify_email: !!row.notify_email };
}

function createRepo(db) {
  const q = {
    listForms: db.prepare(`
      SELECT f.*, (SELECT COUNT(*) FROM responses r WHERE r.form_id = f.id) AS response_count
      FROM forms f ORDER BY f.created_at DESC, f.id DESC`),
    formById: db.prepare('SELECT * FROM forms WHERE id = ?'),
    formBySlug: db.prepare('SELECT * FROM forms WHERE slug = ?'),
    insertForm: db.prepare('INSERT INTO forms (slug, title) VALUES (?, ?)'),
    updateForm: db.prepare(`
      UPDATE forms SET slug = @slug, title = @title, description = @description,
        accent_color = @accent_color, submit_label = @submit_label,
        success_message = @success_message, notify_email = @notify_email,
        webhook_url = @webhook_url
      WHERE id = @id`),
    deleteForm: db.prepare('DELETE FROM forms WHERE id = ?'),
    fieldsForForm: db.prepare('SELECT * FROM fields WHERE form_id = ? ORDER BY position, id'),
    fieldById: db.prepare('SELECT * FROM fields WHERE id = ? AND form_id = ?'),
    maxPosition: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM fields WHERE form_id = ?'),
    insertField: db.prepare(`
      INSERT INTO fields (form_id, type, label, help_text, options, required, position)
      VALUES (@form_id, @type, @label, @help_text, @options, @required, @position)`),
    updateField: db.prepare(`
      UPDATE fields SET type = @type, label = @label, help_text = @help_text,
        options = @options, required = @required
      WHERE id = @id AND form_id = @form_id`),
    deleteField: db.prepare('DELETE FROM fields WHERE id = ? AND form_id = ?'),
    setPosition: db.prepare('UPDATE fields SET position = ? WHERE id = ?'),
    insertResponse: db.prepare('INSERT INTO responses (form_id, data) VALUES (?, ?)'),
    responseById: db.prepare('SELECT * FROM responses WHERE id = ?'),
    deleteResponse: db.prepare('DELETE FROM responses WHERE id = ? AND form_id = ?'),
    countResponses: db.prepare('SELECT COUNT(*) AS n FROM responses WHERE form_id = ?'),
  };

  const moveField = db.transaction((formId, fieldId, direction) => {
    const fields = q.fieldsForForm.all(formId);
    const i = fields.findIndex((f) => f.id === fieldId);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j], fields[i]];
    fields.forEach((f, idx) => q.setPosition.run(idx + 1, f.id));
  });

  return {
    raw: db,
    listForms: () => q.listForms.all().map(hydrateForm),
    getForm: (id) => hydrateForm(q.formById.get(id)),
    getFormBySlug: (slug) => hydrateForm(q.formBySlug.get(slug)),
    createForm: (slug, title) => q.insertForm.run(slug, title).lastInsertRowid,
    updateForm: (form) => q.updateForm.run({ ...form, notify_email: form.notify_email ? 1 : 0 }),
    deleteForm: (id) => q.deleteForm.run(id),
    getFields: (formId) => q.fieldsForForm.all(formId).map(hydrateField),
    getField: (formId, fieldId) => hydrateField(q.fieldById.get(fieldId, formId)),
    addField: (field) =>
      q.insertField.run({
        ...field,
        required: field.required ? 1 : 0,
        position: q.maxPosition.get(field.form_id).p + 1,
      }).lastInsertRowid,
    updateField: (field) => q.updateField.run({ ...field, required: field.required ? 1 : 0 }),
    deleteField: (formId, fieldId) => q.deleteField.run(fieldId, formId),
    moveField,
    addResponse: (formId, data) => q.insertResponse.run(formId, JSON.stringify(data)).lastInsertRowid,
    getResponse: (id) => {
      const row = q.responseById.get(id);
      return row && { ...row, data: JSON.parse(row.data) };
    },
    deleteResponse: (formId, id) => q.deleteResponse.run(id, formId),
    countResponses: (formId) => q.countResponses.get(formId).n,
    // sortKey is either 'created_at' or a field id (validated by the caller).
    listResponses: (formId, sortKey, dir) => {
      const order = dir === 'asc' ? 'ASC' : 'DESC';
      let rows;
      if (sortKey === 'created_at') {
        rows = db
          .prepare(`SELECT * FROM responses WHERE form_id = ? ORDER BY created_at ${order}, id ${order}`)
          .all(formId);
      } else {
        rows = db
          .prepare(
            `SELECT * FROM responses WHERE form_id = ?
             ORDER BY lower(CAST(json_extract(data, ?) AS TEXT)) ${order} NULLS LAST, id ${order}`,
          )
          .all(formId, `$."${Number(sortKey)}"`);
      }
      return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
    },
  };
}

module.exports = { openDb, FIELD_TYPES, parseOptions };
