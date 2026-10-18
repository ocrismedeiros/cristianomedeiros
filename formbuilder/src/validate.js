const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_LEN = { text: 500, email: 254, textarea: 10000 };

const fieldName = (field) => `f_${field.id}`;

// Validate a submission against a form's fields.
// body: parsed urlencoded/multipart fields; files: multer's req.files map.
// Returns { data, errors } where data is keyed by field id.
function validateSubmission(fields, body, files) {
  const data = {};
  const errors = {};

  for (const field of fields) {
    const name = fieldName(field);
    const raw = body[name];

    switch (field.type) {
      case 'text':
      case 'email':
      case 'textarea': {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (!value) {
          if (field.required) errors[field.id] = 'This field is required.';
          break;
        }
        if (value.length > MAX_LEN[field.type]) {
          errors[field.id] = `Keep it under ${MAX_LEN[field.type]} characters.`;
        } else if (field.type === 'email' && !EMAIL_RE.test(value)) {
          errors[field.id] = 'Enter a valid email address.';
        }
        data[field.id] = value;
        break;
      }
      case 'select': {
        const value = typeof raw === 'string' ? raw : '';
        if (!value) {
          if (field.required) errors[field.id] = 'Choose an option.';
          break;
        }
        if (!field.optionList.includes(value)) errors[field.id] = 'Choose one of the listed options.';
        data[field.id] = value;
        break;
      }
      case 'checkbox': {
        if (field.optionList.length === 0) {
          // Single yes/no checkbox (e.g. consent).
          const checked = raw === 'on' || raw === 'yes';
          if (field.required && !checked) errors[field.id] = 'This box must be checked.';
          data[field.id] = checked ? 'yes' : 'no';
        } else {
          const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((v) => typeof v === 'string');
          if (values.some((v) => !field.optionList.includes(v))) {
            errors[field.id] = 'Choose from the listed options.';
          } else if (field.required && values.length === 0) {
            errors[field.id] = 'Select at least one option.';
          }
          data[field.id] = values;
        }
        break;
      }
      case 'file': {
        const file = files && files[name] && files[name][0];
        if (!file) {
          if (field.required) errors[field.id] = 'Attach a file.';
          break;
        }
        data[field.id] = { file };
        break;
      }
    }
  }
  return { data, errors };
}

module.exports = { validateSubmission, fieldName, MAX_LEN };
