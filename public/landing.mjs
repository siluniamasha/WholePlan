const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.site-navigation');
const legacyRun = new URLSearchParams(location.hash.slice(1)).get('run');
if (/^[a-f0-9-]{36}$/.test(legacyRun ?? '')) {
  location.replace('/app?run=' + encodeURIComponent(legacyRun));
}

function closeMenu() {
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open navigation');
  navigation.classList.remove('is-open');
}

menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const wasOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    closeMenu();
    if (wasOpen) menuToggle.focus();
  }
});

const examples = {
  lowest: { label: 'The lowest-price bundle', price: '$220', fee: '$35.00', explanation: 'Costs $25 less upfront, with a $35 declared hotel cancellation fee if this sample booking needs to be cancelled.' },
  flexible: { label: 'The flexible bundle', price: '$245', fee: '$0.00', explanation: 'Costs $25 more upfront, with $35 less in declared cancellation fees if this sample bundle needs to be unwound.' },
};

document.querySelectorAll('[data-choice]').forEach(button => {
  button.addEventListener('click', () => {
    const example = examples[button.dataset.choice];
    document.querySelectorAll('[data-choice]').forEach(tab => {
      const active = tab === button;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('example-label').textContent = example.label;
    const price = document.getElementById('example-price');
    price.replaceChildren(document.createTextNode(example.price));
    const fraction = document.createElement('span');
    fraction.textContent = '.00';
    price.append(fraction);
    document.getElementById('example-fee').textContent = example.fee;
    document.getElementById('example-explanation').textContent = example.explanation;
  });
});
