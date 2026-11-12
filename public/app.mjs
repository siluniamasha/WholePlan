const element = id => document.getElementById(id);
const money = cents => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
}).format(cents / 100);

// Provider text, user briefs, and model output share this escaping boundary.
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const stateLabels = {
  DRAFT: 'Ready for your review', BLOCKED: 'Adjust your limits',
  PREPARING: 'Preparing your plan', AWAITING_APPROVAL: 'Buyer approvals needed',
  READY: 'Ready to complete', RUNNING: 'Processing payments',
  COMPLETED: 'Plan complete', RECOVERY_REQUIRED: 'Recovery needed',
  RECOVERING: 'Recovering payments', OUTCOME_UNKNOWN: 'Checking the outcome',
  REFUND_PENDING: 'Refund pending', RECOVERED: 'Recovery confirmed',
  NEEDS_ATTENTION: 'Needs attention',
};
const attentionStates = ['OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED', 'NEEDS_ATTENTION', 'REFUND_PENDING'];
let config;
let run;
let busy = false;

async function request(path, body) {
  const options = { cache: 'no-store', credentials: 'same-origin' };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrf };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The request could not complete. Try again.');
  return result;
}

function showError(message) {
  element('error').textContent = message;
  element('error').classList.toggle('hidden', !message);
  if (message) element('error').focus({ preventScroll: false });
}

function setBusy(value) {
  busy = value;
  element('plan-form').setAttribute('aria-busy', String(value));
  element('bundle-content').setAttribute('aria-busy', String(value));
  element('plan-form').querySelectorAll('input, textarea, select, button').forEach(control => {
    control.disabled = value;
  });
  element('run-controls').querySelectorAll('button').forEach(button => {
    button.disabled = value;
  });
  element('export-button').disabled = value || !run;
  element('plan-button').innerHTML = value
    ? '<span class="spinner" aria-hidden="true"></span> Working on your plan…'
    : 'Compare my options <span aria-hidden="true">↗</span>';
}

async function work(operation) {
  if (busy) return;
  showError('');
  setBusy(true);
  try {
    await operation();
  } catch (error) {
    showError(error.message);
    // A disconnected response can still have completed on the server.
    if (run) {
      try { run = await request('/api/runs/' + run.id); } catch { /* Keep the last known record. */ }
    }
  } finally {
    setBusy(false);
    if (run) render();
  }
}

function legStatus(leg) {
  if (leg.recoveryError) return { text: leg.recoveryError, className: 'issue' };
  if (leg.refund) return {
    text: 'Refund ' + leg.refund.status.toLowerCase() + ' · ' + money(leg.refundAmount),
    className: leg.refund.status === 'COMPLETED' ? '' : 'pending',
  };
  if (leg.voided) return { text: 'Payment hold released', className: '' };
  if (leg.capture) return {
    text: 'Payment ' + leg.capture.status.toLowerCase(),
    className: leg.capture.status === 'COMPLETED' ? '' : 'pending',
  };
  if (leg.authorization) return { text: 'Payment hold authorized', className: '' };
  if (leg.order) return { text: 'Waiting for your PayPal approval', className: 'pending' };
  return { text: leg.reservation ? 'Inventory reserved' : 'Ready to review', className: 'pending' };
}

function renderLeg(leg) {
  const status = legStatus(leg);
  const reference = leg.refund?.id ?? leg.capture?.id ?? leg.authorization?.id;
  const icon = { ticket: '↗', hotel: '⌂', shuttle: '⇄' }[leg.category];
  const hold = leg.reservation?.status === 'HELD'
    ? '<div class="leg-term">Sample inventory hold until ' + new Date(leg.reservation.expiresAt).toLocaleTimeString() + '</div>' : '';
  return '<article class="leg"><div class="leg-icon" aria-hidden="true">' + icon + '</div>' +
    '<div class="leg-main"><div class="leg-title"><span>' + escape(leg.name) + '</span><span>' + money(leg.amount) + '</span></div>' +
    '<div class="leg-sub">' + escape(leg.seller) + ' · ' + leg.travelers + ' traveler' + (leg.travelers > 1 ? 's' : '') + '</div>' +
    '<div class="leg-term">' + escape(leg.term) + (leg.travelers > 1 ? ' Terms shown per person.' : '') + '</div>' +
    '<div class="leg-finance ' + status.className + '">' + escape(status.text) + '</div>' + hold +
    (reference ? '<details class="leg-reference"><summary>Payment reference</summary><div class="leg-ref">' + escape(reference) + '</div></details>' : '') +
    '</div></article>';
}

function runMessage() {
  const summary = run.summary;
  const messages = {
    DRAFT: 'Review the prices and cancellation terms. Preparing will reserve sample inventory and create payment holds.',
    BLOCKED: 'Try a different budget or cancellation allowance. Your current limits have been kept.',
    PREPARING: 'Preparation needs another check. Resume with the saved payment identifiers, or recover the known holds.',
    AWAITING_APPROVAL: 'Approve each seller’s PayPal Sandbox order below. Return here after each approval.',
    READY: run.legs.some(leg => leg.capture)
      ? 'Your earlier payment was verified. Continue to complete the remaining purchases.'
      : 'Every seller’s payment hold is ready. Complete the bundle when you’re ready to proceed.',
    COMPLETED: 'Every payment and sample booking is confirmed. Your complete plan is recorded below.',
    RECOVERY_REQUIRED: 'The checkout stopped. ' + run.recoveryReason + ' Start recovery to follow the accepted cancellation terms.',
    OUTCOME_UNKNOWN: 'A payment response is missing or pending. Check provider records to find its outcome before continuing.',
    REFUND_PENDING: money(summary.refundPending) + ' is awaiting refund confirmation. Check provider records again to follow its progress.',
    RECOVERED: 'Recovery is confirmed. ' + money(summary.netCharged) + ' remains charged under the accepted terms. Your bank may take additional time to make refunded funds available.',
    NEEDS_ATTENTION: 'Recovery needs attention. ' + money(summary.netCharged) + ' remains charged and ' + money(summary.held) + ' remains authorized. Follow the outstanding steps in Activity.',
    RECOVERING: 'Recovery was interrupted. Check the saved provider records to resume.',
  };
  let message = messages[run.state] ?? 'Check the latest activity for this plan.';
  if (summary.capturePending) message += ' A ' + money(summary.capturePending) + ' capture is still pending.';
  if (run.operations.some(operation => ['UNKNOWN', 'STARTED'].includes(operation.status))) {
    message += ' The totals show confirmed records. Unknown operations can change these amounts.';
  }
  return message;
}

function actionButton(action, label, primary = false) {
  return '<button class="button ' + (primary ? 'button-primary' : action === 'recover' ? 'button-danger' : '') +
    '" data-action="' + action + '">' + label + '</button>';
}

function renderControls() {
  const buttons = [];
  if (['DRAFT', 'PREPARING'].includes(run.state)) {
    buttons.push(actionButton('prepare', run.state === 'DRAFT' ? 'Approve terms & prepare ↗' : 'Resume preparation ↗', true));
  }
  if (['READY', 'RUNNING'].includes(run.state)) buttons.push(actionButton('commit', 'Complete this bundle ↗', true));
  if (['OUTCOME_UNKNOWN', 'REFUND_PENDING', 'NEEDS_ATTENTION', 'RUNNING', 'RECOVERING'].includes(run.state)) {
    buttons.push(actionButton('reconcile', 'Check provider records ↻'));
  }
  if (['READY', 'AWAITING_APPROVAL', 'PREPARING', 'RUNNING', 'OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED', 'RECOVERING', 'NEEDS_ATTENTION', 'REFUND_PENDING'].includes(run.state)) {
    buttons.push(actionButton('recover', 'Start recovery'));
  }
  element('run-controls').innerHTML = buttons.join('');
  element('run-controls').querySelectorAll('[data-action]').forEach(button => {
    button.disabled = busy;
    button.addEventListener('click', () => work(async () => {
      run = await request('/api/runs/' + run.id + '/' + button.dataset.action, { manifestHash: run.manifestHash });
    }));
  });
}

function safeApprovalUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://www.sandbox.paypal.com' && !url.username && !url.password) return url.href;
  } catch { /* Invalid provider links stay inactive. */ }
  return null;
}

function render() {
  element('empty-state').classList.add('hidden');
  element('bundle-content').classList.remove('hidden');
  const warning = attentionStates.includes(run.state);
  element('bundle-state').textContent = stateLabels[run.state] ?? run.state;
  element('bundle-state').className = 'badge ' + (warning ? 'badge-warning' : ['COMPLETED', 'RECOVERED'].includes(run.state) ? 'badge-success' : '');
  const source = run.interpretation.source === 'gemini' ? 'Interpreted with Gemini' : 'Sample itinerary · rule-based';
  const evidence = run.interpretation.evidence?.length
    ? '<div class="leg-term">From your brief · ' + run.interpretation.evidence.map(quote => '“' + escape(quote) + '”').join(' · ') + '</div>' : '';
  element('interpretation').innerHTML = '<span class="source-tag">' + source + '</span>' + escape(run.interpretation.summary) + evidence;
  const cheapest = run.plan.cheapest;
  const chosen = run.plan.chosen;
  element('comparison').innerHTML =
    '<div class="comparison-card"><span>Lowest price</span><div class="price">' + money(cheapest.total) + '</div><p>' +
    money(cheapest.declaredLoss) + ' cancellation fees<br>' +
    (cheapest.declaredLoss > run.plan.constraints.maxLoss ? 'Above your accepted fees' : 'Within your accepted fees') +
    '</p></div><div class="comparison-card chosen"><span>' + (chosen ? 'Your eligible bundle' : 'Adjust your limits') +
    '</span><div class="price">' + (chosen ? money(chosen.total) : '—') + '</div><p>' +
    (chosen ? '<strong>' + money(chosen.declaredLoss) + ' cancellation fees</strong><br>Within your ' + money(run.plan.constraints.budget) + ' budget'
      : 'At least ' + money(run.plan.requiredBudget) + ' needed for these terms') + '</p></div>';
  element('plan-reason').textContent = run.plan.reason + ' ' + run.plan.compared + ' sample combinations compared.';
  element('legs').innerHTML = run.legs.map(renderLeg).join('');
  element('approval-controls').replaceChildren();
  if (run.mode === 'sandbox' && run.state === 'AWAITING_APPROVAL') {
    for (const leg of run.legs.filter(item => !item.authorization)) {
      const url = safeApprovalUrl(leg.order?.approvalUrl);
      if (!url) continue;
      const row = document.createElement('div');
      row.className = 'approval-row';
      const label = document.createElement('span');
      label.textContent = leg.seller + ' · ' + money(leg.amount);
      const link = document.createElement('a');
      link.className = 'button';
      link.href = url;
      link.textContent = 'Approve Sandbox hold ↗';
      row.append(label, link);
      element('approval-controls').append(row);
    }
  }
  const metrics = [['held', 'Payment holds'], ['charged', 'Charged'], ['refunded', 'Refunded'], ['refundPending', 'Refund pending']];
  element('financial-summary').innerHTML = metrics.map(([key, label]) => '<div><span>' + label + '</span><strong>' + money(run.summary[key]) + '</strong></div>').join('');
  element('run-message').textContent = runMessage();
  element('run-message').className = 'run-message' + (warning ? ' alert' : '');
  renderControls();
  element('manifest-note').textContent = run.manifestHash
    ? 'Reviewed version ' + run.manifestHash + '. ' + (run.mode === 'simulation' ? 'SIM references are local simulation records.' : 'Payment references come from PayPal Sandbox.') + ' Supplier bookings use sample inventory.'
    : 'Change your limits and compare another plan.';
  element('timeline').innerHTML = run.events.map(event => {
    const eventClass = /REJECTED|UNRESOLVED|ATTENTION/.test(event.type) ? 'issue' : /UNKNOWN|PENDING/.test(event.type) ? 'warn' : '';
    const time = new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return '<div class="timeline-item ' + eventClass + '"><time>' + escape(time) + '</time><div class="timeline-dot"></div><div><span class="timeline-kind">' +
      escape(event.type.replaceAll('_', ' ')) + '</span>' + escape(event.message) +
      (event.details?.providerId ? '<div class="leg-ref">' + escape(event.details.providerId) + '</div>' : '') + '</div></div>';
  }).join('');
  element('timeline').scrollTop = element('timeline').scrollHeight;
  element('export-button').disabled = busy;
  const step = run.state === 'BLOCKED' ? 1 : run.state === 'DRAFT' ? 2 :
    ['PREPARING', 'AWAITING_APPROVAL', 'READY'].includes(run.state) ? 3 : 4;
  document.querySelectorAll('[data-step]').forEach(item => {
    const number = Number(item.dataset.step);
    item.classList.toggle('is-complete', number < step);
    if (number === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

element('plan-form').addEventListener('submit', event => {
  event.preventDefault();
  work(async () => {
    run = await request('/api/plans', {
      brief: element('brief').value,
      budget: Math.round(Number(element('budget').value) * 100),
      maxLoss: Math.round(Number(element('max-loss').value) * 100),
      travelers: Number(element('travelers').value),
      scenario: element('scenario').value,
      useRules: element('use-rules').checked,
    });
    const url = new URL(location.href);
    url.searchParams.set('run', run.id);
    url.hash = '';
    history.replaceState(null, '', url);
    render();
    if (window.matchMedia('(max-width: 680px)').matches) {
      element('review-title').scrollIntoView({ block: 'start' });
    }
  });
});
element('export-button').addEventListener('click', () => {
  if (run) location.href = '/api/runs/' + run.id + '/evidence';
});

const guide = element('guide-dialog');
document.querySelectorAll('[data-open-guide]').forEach(button => {
  button.addEventListener('click', () => guide.showModal());
});
element('close-guide').addEventListener('click', () => guide.close());
element('start-planning').addEventListener('click', () => {
  guide.close();
  element('brief').focus();
});
guide.addEventListener('click', event => {
  if (event.target !== guide) return;
  const bounds = guide.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) guide.close();
});
document.querySelectorAll('.app-nav-link[href^="#"]').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.app-nav-link').forEach(item => {
      const active = item === link;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  });
});

function describeScenario() {
  element('scenario-description').textContent = config.scenarios[element('scenario').value]?.description ?? '';
}
element('scenario').addEventListener('change', describeScenario);

async function init() {
  try {
    config = await request('/api/session');
    element('provider-badge').textContent = config.mode === 'simulation' ? 'Simulation mode' : 'PayPal Sandbox';
    element('notice').textContent = config.mode === 'simulation'
      ? 'You’re exploring sample trips with simulated payments. All suppliers, prices and booking availability are fictional.'
      : 'PayPal Sandbox is active with test funds. Each seller needs a separate buyer approval. Supplier listings and inventory are sample data.';
    element('scenario').innerHTML = Object.entries(config.scenarios)
      .filter(([key]) => config.mode === 'simulation' || key === 'success')
      .map(([key, value]) => '<option value="' + escape(key) + '">' + escape(value.name) + '</option>').join('');
    const params = new URLSearchParams(location.search);
    const requestedScenario = params.get('scenario');
    if (config.mode === 'simulation' && Object.hasOwn(config.scenarios, requestedScenario)) element('scenario').value = requestedScenario;
    if (params.get('example') === 'flexible' && config.mode === 'simulation') element('scenario').value = 'confirmation_failure';
    describeScenario();
    element('use-rules').checked = !config.aiConfigured;
    element('ai-source').textContent = config.aiConfigured
      ? 'Uncheck to let Gemini interpret your brief. You’ll review its result before proceeding.'
      : 'The demo uses a fixed concert itinerary. AI interpretation becomes available when Gemini is configured.';
    element('plan-button').disabled = false;
    const id = params.get('run') ?? new URLSearchParams(location.hash.slice(1)).get('run');
    if (id) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('This plan link is invalid. Start a new comparison below.');
      run = await request('/api/runs/' + id);
      element('brief').value = run.brief;
      element('budget').value = (run.plan.constraints.budget / 100).toFixed(2);
      element('max-loss').value = (run.plan.constraints.maxLoss / 100).toFixed(2);
      element('travelers').value = String(run.plan.constraints.travelers);
      element('scenario').value = run.scenario;
      element('use-rules').checked = run.interpretation.source === 'rules';
      describeScenario();
      render();
    }
  } catch (error) {
    showError(error.message);
    if (!config) element('notice').textContent = 'The workspace service is unavailable. Refresh when the local server is running.';
  }
}
init();
