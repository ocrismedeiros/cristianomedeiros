// Client-side validation for public forms. The server re-validates everything.
(function () {
  var form = document.querySelector('form[data-max-bytes]');
  if (!form) return;
  var maxBytes = Number(form.getAttribute('data-max-bytes'));

  function setError(wrapper, message) {
    var el = wrapper.querySelector('.error');
    var inputs = wrapper.querySelectorAll('input, textarea, select');
    el.textContent = message || '';
    el.hidden = !message;
    for (var i = 0; i < inputs.length; i++) inputs[i].setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function check(wrapper) {
    if (wrapper.hasAttribute('data-required-group')) {
      var ok = wrapper.querySelector('input[type=checkbox]:checked');
      return ok ? '' : 'Select at least one option.';
    }
    var input = wrapper.querySelector('input, textarea, select');
    if (!input) return '';
    if (input.type === 'file' && input.files && input.files[0] && input.files[0].size > maxBytes) {
      return 'File is too large (max 10 MB).';
    }
    if (input.validity.valid) return '';
    if (input.validity.valueMissing) {
      if (input.type === 'checkbox') return 'This box must be checked.';
      if (input.type === 'file') return 'Attach a file.';
      if (input.tagName === 'SELECT') return 'Choose an option.';
      return 'This field is required.';
    }
    if (input.validity.typeMismatch && input.type === 'email') return 'Enter a valid email address.';
    if (input.validity.tooLong) return 'This answer is too long.';
    return input.validationMessage;
  }

  var wrappers = form.querySelectorAll('[data-field]');

  form.addEventListener('submit', function (e) {
    var first = null;
    for (var i = 0; i < wrappers.length; i++) {
      var msg = check(wrappers[i]);
      setError(wrappers[i], msg);
      if (msg && !first) first = wrappers[i];
    }
    if (first) {
      e.preventDefault();
      var focusable = first.querySelector('input, textarea, select');
      if (focusable) focusable.focus();
      return;
    }
    var btn = form.querySelector('.submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';
  });

  // Clear an error as soon as the field becomes valid.
  form.addEventListener('change', function (e) {
    var w = e.target.closest('[data-field]');
    if (w && !w.querySelector('.error').hidden) setError(w, check(w));
  });
  form.addEventListener('input', function (e) {
    var w = e.target.closest('[data-field]');
    if (w && !w.querySelector('.error').hidden) setError(w, check(w));
  });
})();
