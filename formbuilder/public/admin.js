// Confirm dialogs for destructive actions, and show the options box only
// for field types that use it. (No inline handlers: the CSP forbids them.)
document.addEventListener('submit', function (e) {
  var msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});

function syncOptions(select) {
  var form = select.closest('form');
  var box = form && form.querySelector('[data-options]');
  if (box) box.hidden = !(select.value === 'select' || select.value === 'checkbox');
}

document.querySelectorAll('[data-field-type]').forEach(function (select) {
  syncOptions(select);
  select.addEventListener('change', function () {
    syncOptions(select);
  });
});
