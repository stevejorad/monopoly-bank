// ═══════════════════════════════════════════════════════════════
// app.js — Monopoly Bank application logic
// ═══════════════════════════════════════════════════════════════

const PLAYER_COLORS = ['#e63946','#2a9d8f','#f4a261','#6a7fc1','#e9c46a','#b5838d'];

const S = {
  gameId:      null,
  game:        null,
  players:     [],
  myPlayerId:  null,
  transactions: [],
  pendingTxns: [],
  lastRoll:    null,
  channel:     null,
  approvalTxn: null,
};

// ── Utilities ─────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }
function fmt(n) { return '$' + Math.abs(n).toLocaleString(); }
function me() { return S.players.find(p => p.id === S.myPlayerId) ?? null; }
function active() { return S.players.filter(p => p.is_active); }

function playerColor(id) {
  const idx = S.players.findIndex(p => p.id === id);
  return PLAYER_COLORS[idx % PLAYER_COLORS.length] ?? '#888';
}

function playerName(id) {
  if (!id) return 'Bank';
  return S.players.find(p => p.id === id)?.name ?? '?';
}

function localKey() { return `mpbk_${S.gameId}`; }

function saveIdentity(playerId) {
  localStorage.setItem(localKey(), JSON.stringify({ playerId }));
}

function loadIdentity() {
  try { return JSON.parse(localStorage.getItem(localKey())); } catch { return null; }
}

function randomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  S.gameId = params.get('g');

  if (!S.gameId) {
    showScreen('screen-welcome');
    return;
  }

  const identity = loadIdentity();
  if (identity?.playerId) {
    S.myPlayerId = identity.playerId;
    try {
      await loadGameState();
      if (S.game.status === 'lobby') {
        showScreen('screen-lobby');
        renderLobby();
      } else {
        showScreen('screen-game');
        renderGame();
      }
      subscribe();
    } catch {
      showScreen('screen-join');
    }
  } else {
    try {
      await DB.getGame(S.gameId);
      showScreen('screen-join');
    } catch {
      showScreen('screen-welcome');
    }
  }
}

async function loadGameState() {
  const [game, players, transactions, lastRoll, pendingTxns] = await Promise.all([
    DB.getGame(S.gameId),
    DB.getPlayers(S.gameId),
    DB.getRecentTransactions(S.gameId, 5),
    DB.getLastRoll(S.gameId),
    DB.getPendingTransactions(S.gameId),
  ]);
  S.game         = game;
  S.players      = players;
  S.transactions = transactions;
  S.lastRoll     = lastRoll;
  S.pendingTxns  = pendingTxns;
}

// ── Welcome ───────────────────────────────────────────────────

$('btn-new-game').addEventListener('click', () => showScreen('screen-setup'));
$('btn-join-game').addEventListener('click', () => showScreen('screen-join'));

// ── Setup ─────────────────────────────────────────────────────

$('btn-create-game').addEventListener('click', async () => {
  const name      = $('setup-name').value.trim();
  const balance   = parseInt($('setup-balance').value) || 1500;
  const threshold = $('setup-threshold').value;

  if (!name) { alert('Enter your name'); return; }

  const btn = $('btn-create-game');
  btn.disabled = true; btn.textContent = 'Creating…';

  try {
    S.gameId = randomId();
    await DB.createGame(S.gameId, balance, threshold);
    const player = await DB.addPlayer(S.gameId, name, balance);
    S.myPlayerId  = player.id;
    saveIdentity(player.id);
    history.replaceState(null, '', `?g=${S.gameId}`);
    await loadGameState();
    showScreen('screen-lobby');
    renderLobby();
    subscribe();
  } catch (e) {
    console.error(e);
    alert('Failed to create game.\n\nMake sure you have added your Supabase credentials to db.js.');
    btn.disabled = false; btn.textContent = 'Create Game';
  }
});

// ── Lobby ─────────────────────────────────────────────────────

function renderLobby() {
  const url = location.href;

  $('qr-code').innerHTML = '';
  try {
    new QRCode($('qr-code'), {
      text: url, width: 200, height: 200,
      colorDark: '#1a472a', colorLight: '#ffffff',
    });
  } catch {
    $('qr-code').textContent = url;
  }

  $('lobby-url').textContent = url;
  renderLobbyPlayers();
}

function renderLobbyPlayers() {
  $('lobby-players').innerHTML = S.players.map(p => `
    <div class="prow">
      <div class="avatar" style="background:${playerColor(p.id)}">${p.name[0].toUpperCase()}</div>
      <div class="pinfo">
        <div class="nm">${p.name}${p.id === S.myPlayerId ? ' (you)' : ''}</div>
      </div>
    </div>`).join('');

  const btn = $('btn-start-game');
  btn.disabled = S.players.length < 2;
  btn.textContent = S.players.length < 2
    ? 'Waiting for players…'
    : `Start Game (${S.players.length} players)`;
}

$('btn-start-game').addEventListener('click', async () => {
  $('btn-start-game').disabled = true;
  const shuffled = [...S.players]
    .sort(() => Math.random() - 0.5)
    .map((p, i) => ({ ...p, turn_order: i }));
  await DB.setTurnOrder(shuffled);
  await DB.startGame(S.gameId, shuffled[0].id);
  S.game    = { ...S.game, status: 'active', current_turn_id: shuffled[0].id };
  S.players = shuffled.sort((a, b) => a.turn_order - b.turn_order);
  showScreen('screen-game');
  renderGame();
});

// ── Join ──────────────────────────────────────────────────────

$('btn-join').addEventListener('click', async () => {
  const name = $('join-name').value.trim();
  if (!name) { alert('Enter your name'); return; }
  if (!S.gameId) { alert('No game found. Scan the QR code again.'); return; }

  const btn = $('btn-join');
  btn.disabled = true; btn.textContent = 'Joining…';

  try {
    S.game = await DB.getGame(S.gameId);
    const player = await DB.addPlayer(S.gameId, name, S.game.starting_balance);
    S.myPlayerId  = player.id;
    saveIdentity(player.id);
    await loadGameState();
    if (S.game.status === 'lobby') {
      showScreen('screen-lobby');
      renderLobby();
    } else {
      showScreen('screen-game');
      renderGame();
    }
    subscribe();
  } catch (e) {
    console.error(e);
    alert('Failed to join. Try again.');
    btn.disabled = false; btn.textContent = 'Join';
  }
});

// ── Game screen ───────────────────────────────────────────────

function renderGame() {
  const player = me();
  if (!player) return;

  $('my-name').textContent    = player.name;
  $('my-balance').textContent = fmt(player.balance);

  const isMyTurn = S.game?.current_turn_id === S.myPlayerId;
  $('turn-badge').style.display  = isMyTurn ? 'inline-flex' : 'none';
  $('turn-card').style.display   = isMyTurn ? 'block' : 'none';

  // Bankruptcy button — show when broke
  const broke = player.balance <= 0;
  $('btn-bankruptcy').style.display = broke ? 'inline-block' : 'none';

  $('last-roll').textContent = (isMyTurn && S.lastRoll?.player_id === S.myPlayerId)
    ? `Last roll: ${S.lastRoll.die1} + ${S.lastRoll.die2} = ${S.lastRoll.die1 + S.lastRoll.die2}`
    : '';

  const lrc = $('last-roll-card');
  if (!isMyTurn && S.lastRoll) {
    const roller = playerName(S.lastRoll.player_id);
    const dbl    = S.lastRoll.die1 === S.lastRoll.die2 ? ' — doubles!' : '';
    $('last-roll-other').textContent =
      `${roller} rolled ${S.lastRoll.die1}+${S.lastRoll.die2}=${S.lastRoll.die1 + S.lastRoll.die2}${dbl}`;
    lrc.style.display = 'block';
  } else {
    lrc.style.display = 'none';
  }

  renderScoreboard();
  renderWhoDropdown();
  updateSendButton();
  renderTransactions();
  renderPendingApprovals();
}

function renderScoreboard() {
  $('scoreboard').innerHTML = active()
    .sort((a, b) => b.balance - a.balance)
    .map((p, i) => {
      const isMe   = p.id === S.myPlayerId;
      const isTurn = p.id === S.game?.current_turn_id;
      return `<div class="sb-row${isMe ? ' you' : ''}">
        <span class="sb-rank">${i + 1}</span>
        <div class="sb-av" style="background:${playerColor(p.id)}">${p.name[0].toUpperCase()}</div>
        <span class="sb-name${isMe ? ' you-label' : ''}">${p.name}${isTurn ? ' 🎲' : ''}</span>
        <span class="sb-amt">${fmt(p.balance)}</span>
      </div>`;
    }).join('');
}

function renderWhoDropdown() {
  const sel  = $('sel-who');
  const prev = sel.value;
  sel.innerHTML =
    '<option value="bank">Bank</option>' +
    S.players
      .filter(p => p.is_active && p.id !== S.myPlayerId)
      .map(p => `<option value="${p.id}">${p.name}</option>`)
      .join('') +
    '<option value="everyone">Everyone</option>';
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// ── Transaction form ──────────────────────────────────────────

function txnNeedsApproval(dir) {
  return dir === 'collect';
}

function updateSendButton() {
  const amount = parseInt($('txn-amount').value) || 0;
  const dir    = $('sel-direction').value;
  const who    = $('sel-who').value;
  const needs  = txnNeedsApproval(dir);

  $('btn-send').disabled    = amount <= 0;
  $('btn-send').textContent = needs ? 'Request' : 'Send';

  const warn = $('txn-warn');
  if (needs && amount > 0) {
    const voterDesc = (who !== 'bank' && who !== 'everyone')
      ? playerName(who) : 'other players';
    $('txn-warn-text').textContent = `Requires approval from ${voterDesc}.`;
    warn.style.display = 'flex';
  } else {
    warn.style.display = 'none';
  }
}

$('sel-direction').addEventListener('change', updateSendButton);
$('sel-who').addEventListener('change', updateSendButton);
$('txn-amount').addEventListener('input', updateSendButton);

$('btn-send').addEventListener('click', async () => {
  const dir    = $('sel-direction').value;
  const who    = $('sel-who').value;
  const amount = parseInt($('txn-amount').value);
  if (!amount || amount <= 0) return;

  const btn = $('btn-send');
  btn.disabled = true;

  try {
    let fromId = null, toId = null, toEveryone = false;

    if (dir === 'pay') {
      fromId    = S.myPlayerId;
      toId      = (who === 'bank' || who === 'everyone') ? null : who;
      toEveryone = who === 'everyone';
    } else {
      toId       = S.myPlayerId;
      fromId     = (who === 'bank' || who === 'everyone') ? null : who;
      toEveryone = who === 'everyone';
    }

    const desc   = buildDesc(dir, who);
    const status = txnNeedsApproval(dir) ? 'pending_approval' : 'completed';

    const txn = await DB.createTransaction({
      game_id:        S.gameId,
      initiator_id:   S.myPlayerId,
      from_player_id: fromId,
      to_player_id:   toId,
      to_everyone:    toEveryone,
      amount,
      description:    desc,
      status,
    });

    if (status === 'completed') {
      await applyBalances(txn, S.players);
      S.players      = await DB.getPlayers(S.gameId);
      S.transactions = await DB.getRecentTransactions(S.gameId, 5);
      renderGame();
    }

    $('txn-amount').value = '';
    updateSendButton();
  } catch (e) {
    console.error(e);
    alert('Transaction failed: ' + e.message);
  }

  updateSendButton();
});

function buildDesc(dir, who) {
  if (who === 'bank')     return dir === 'pay' ? 'Paid bank'        : 'Collected from bank';
  if (who === 'everyone') return dir === 'pay' ? 'Paid everyone'    : 'Collected from everyone';
  const name = playerName(who);
  return dir === 'pay' ? `Paid ${name}` : `Collected from ${name}`;
}

async function applyBalances(txn, players) {
  const live    = players.filter(p => p.is_active);
  const updates = [];

  if (txn.to_everyone) {
    if (txn.from_player_id) {
      const payer = live.find(p => p.id === txn.from_player_id);
      const recps = live.filter(p => p.id !== txn.from_player_id);
      if (payer) updates.push(DB.updateBalance(payer.id, payer.balance - txn.amount * recps.length));
      recps.forEach(p => updates.push(DB.updateBalance(p.id, p.balance + txn.amount)));
    } else {
      const receiver = live.find(p => p.id === txn.to_player_id);
      const payers   = live.filter(p => p.id !== txn.to_player_id);
      if (receiver) updates.push(DB.updateBalance(receiver.id, receiver.balance + txn.amount * payers.length));
      payers.forEach(p => updates.push(DB.updateBalance(p.id, p.balance - txn.amount)));
    }
  } else {
    if (txn.from_player_id) {
      const payer = live.find(p => p.id === txn.from_player_id);
      if (payer) updates.push(DB.updateBalance(payer.id, payer.balance - txn.amount));
    }
    if (txn.to_player_id) {
      const receiver = live.find(p => p.id === txn.to_player_id);
      if (receiver) updates.push(DB.updateBalance(receiver.id, receiver.balance + txn.amount));
    }
  }

  await Promise.all(updates);
}

// ── Bankruptcy ───────────────────────────────────────────────

$('btn-bankruptcy').addEventListener('click', async () => {
  if (!confirm('Declare bankruptcy and leave the game?')) return;
  $('btn-bankruptcy').disabled = true;
  try {
    // If it's my turn, advance to next player first
    if (S.game?.current_turn_id === S.myPlayerId) {
      const sorted = active().filter(p => p.id !== S.myPlayerId).sort((a, b) => a.turn_order - b.turn_order);
      if (sorted.length) await DB.advanceTurn(S.gameId, sorted[0].id);
    }
    await DB.declareBankruptcy(S.myPlayerId);
    // Show the GIF locally immediately; others see it via realtime
    showBankruptcyOverlay(me()?.name ?? 'Someone');
  } catch (e) {
    console.error(e);
    $('btn-bankruptcy').disabled = false;
  }
});

function showBankruptcyOverlay(name) {
  $('bankruptcy-name').textContent = name;
  // Reload GIF by resetting src
  const gif = $('bankruptcy-gif');
  const src = gif.src;
  gif.src = '';
  gif.src = src;
  $('overlay-bankruptcy').classList.add('active');
  // Auto-dismiss after 6 seconds
  setTimeout(() => $('overlay-bankruptcy').classList.remove('active'), 6000);
}

// ── Dice ──────────────────────────────────────────────────────

$('btn-roll').addEventListener('click', async () => {
  if (S.game?.current_turn_id !== S.myPlayerId) return;

  $('btn-roll').disabled    = true;
  $('btn-pass-go').disabled = true;

  const d1      = Math.floor(Math.random() * 6) + 1;
  const d2      = Math.floor(Math.random() * 6) + 1;
  const doubles = d1 === d2;

  await animateDiceRoll(d1, d2, doubles, 'You');
  await DB.recordRoll(S.gameId, S.myPlayerId, d1, d2);
  S.lastRoll = { game_id: S.gameId, player_id: S.myPlayerId, die1: d1, die2: d2 };

  if (!doubles) {
    const sorted = active().sort((a, b) => a.turn_order - b.turn_order);
    const myIdx  = sorted.findIndex(p => p.id === S.myPlayerId);
    const next   = sorted[(myIdx + 1) % sorted.length];
    await DB.advanceTurn(S.gameId, next.id);
    S.game = { ...S.game, current_turn_id: next.id };
  }

  $('btn-roll').disabled    = false;
  $('btn-pass-go').disabled = false;
  renderGame();
});

$('btn-pass-go').addEventListener('click', async () => {
  $('btn-pass-go').disabled = true;
  try {
    await DB.createTransaction({
      game_id:        S.gameId,
      initiator_id:   S.myPlayerId,
      from_player_id: null,
      to_player_id:   S.myPlayerId,
      to_everyone:    false,
      amount:         200,
      description:    'Pass Go',
      status:         'pending_approval',
    });
  } catch (e) {
    console.error(e);
    alert('Failed: ' + e.message);
  }
  $('btn-pass-go').disabled = false;
});

function animateDiceRoll(d1, d2, doubles, rollerName) {
  return new Promise(resolve => {
    const overlay = $('overlay-dice');
    let done = false, resolved = false;

    const dismiss = () => {
      if (!done || resolved) return;
      resolved = true;
      overlay.classList.remove('active');
      overlay.removeEventListener('click', dismiss);
      resolve();
    };

    overlay.addEventListener('click', dismiss);
    $('dice-roller-name').textContent = rollerName ? `${rollerName} rolled` : '';
    $('dice-a').textContent   = '?';
    $('dice-b').textContent   = '?';
    $('dice-total').textContent = '';
    $('dice-doubles').style.display = 'none';
    overlay.classList.add('active');

    let tick = 0;
    const timer = setInterval(() => {
      $('dice-a').textContent = Math.floor(Math.random() * 6) + 1;
      $('dice-b').textContent = Math.floor(Math.random() * 6) + 1;
      if (++tick >= 14) {
        clearInterval(timer);
        $('dice-a').textContent = d1;
        $('dice-b').textContent = d2;
        $('dice-total').textContent = `= ${d1 + d2}`;
        if (doubles) $('dice-doubles').style.display = 'block';
        done = true;
        setTimeout(dismiss, 1800);
      }
    }, 80);
  });
}

// ── Recent transactions ───────────────────────────────────────

function renderTransactions() {
  const list = $('transactions-list');
  if (!S.transactions.length) {
    list.innerHTML = '<p style="color:#bbb;font-size:13px;text-align:center;padding:12px 0">No transactions yet</p>';
    return;
  }
  list.innerHTML = S.transactions.map(txn => {
    const fromName = txn.from_player?.name ?? 'Bank';
    const toName   = txn.to_player?.name   ?? (txn.to_everyone ? 'Everyone' : 'Bank');
    const desc     = txn.description || `${fromName} → ${toName}`;
    const isOwn    = txn.initiator_id === S.myPlayerId;

    return `<div class="tx">
      <div class="txic" style="background:#e8f5e9">💸</div>
      <div class="txd">
        <div class="desc">${desc}</div>
        <div class="time">${fromName} → ${toName}</div>
      </div>
      <span class="txamt">${fmt(txn.amount)}</span>
      ${isOwn ? `<div class="tx-acts"><button class="tx-act" onclick="requestDelete('${txn.id}')">🗑️</button></div>` : ''}
    </div>`;
  }).join('');
}

async function requestDelete(txnId) {
  if (!confirm('Request to reverse this transaction?\nOther players will need to approve.')) return;
  try {
    const txn = await DB.getTransactionById(txnId);
    await DB.createTransaction({
      game_id:        S.gameId,
      initiator_id:   S.myPlayerId,
      from_player_id: txn.to_player_id,
      to_player_id:   txn.from_player_id,
      to_everyone:    txn.to_everyone,
      amount:         txn.amount,
      description:    `Undo: ${txn.description ?? 'transaction'}`,
      status:         'pending_approval',
    });
  } catch (e) {
    console.error(e);
    alert('Failed: ' + e.message);
  }
}

// ── Approval overlay ──────────────────────────────────────────

function eligibleVoters(txn) {
  if (txn.from_player_id && txn.from_player_id !== txn.initiator_id) {
    return [txn.from_player_id];
  }
  return S.players.filter(p => p.is_active && p.id !== txn.initiator_id).map(p => p.id);
}

async function renderPendingApprovals() {
  const notMine = S.pendingTxns.filter(t => t.initiator_id !== S.myPlayerId);
  if (notMine.length) { await showApprovalOverlay(notMine[0], false); return; }

  const mine = S.pendingTxns.filter(t => t.initiator_id === S.myPlayerId);
  if (mine.length) { await showApprovalOverlay(mine[0], true); return; }

  hideApprovalOverlay();
}

async function showApprovalOverlay(txn, isInitiator) {
  S.approvalTxn = txn;

  const toName      = txn.to_everyone ? 'Everyone' : (txn.to_player_id ? playerName(txn.to_player_id) : 'Bank');
  const initiator   = txn.initiator?.name ?? playerName(txn.initiator_id);

  $('approval-title').textContent = txn.description || `${playerName(txn.from_player_id)} → ${toName}`;
  $('approval-desc').textContent  = `${fmt(txn.amount)} · Requested by ${initiator}`;

  const votes   = await DB.getVotes(txn.id);
  const eligible = eligibleVoters(txn);

  $('approval-votes').innerHTML = eligible.map(pid => {
    const v   = votes.find(vt => vt.player_id === pid);
    const cls = v ? (v.vote === 'approve' ? 'yes' : 'no') : 'wait';
    const lbl = v ? (v.vote === 'approve' ? '✓ Yes'  : '✗ No')  : '…';
    return `<div class="vote-av">
      <div class="av" style="background:${playerColor(pid)}">${playerName(pid)[0].toUpperCase()}</div>
      <div class="vl ${cls}">${lbl}</div>
    </div>`;
  }).join('');

  const myVote     = votes.find(v => v.player_id === S.myPlayerId);
  const amEligible = eligible.includes(S.myPlayerId);
  const note       = $('approval-threshold-note');
  const btns       = $('approval-btns');
  const close      = $('btn-close-approval');

  if (isInitiator) {
    btns.style.display  = 'none';
    close.style.display = 'none';
    note.textContent    = 'Waiting for approval from other players…';
  } else if (!amEligible) {
    btns.style.display  = 'none';
    close.style.display = 'block';
    note.textContent    = 'You are not a required voter for this.';
  } else if (myVote) {
    btns.style.display  = 'none';
    close.style.display = 'block';
    note.textContent    = `You voted: ${myVote.vote === 'approve' ? '✓ Approved' : '✗ Denied'}`;
  } else {
    btns.style.display  = 'grid';
    close.style.display = 'none';
    note.textContent    = '';
  }

  $('overlay-approval').classList.add('active');
}

function hideApprovalOverlay() {
  $('overlay-approval').classList.remove('active');
  S.approvalTxn = null;
}

$('btn-approve').addEventListener('click', () => castMyVote('approve'));
$('btn-deny').addEventListener('click',    () => castMyVote('deny'));
$('btn-close-approval').addEventListener('click', hideApprovalOverlay);

async function castMyVote(vote) {
  if (!S.approvalTxn) return;
  $('btn-approve').disabled = true;
  $('btn-deny').disabled    = true;
  try {
    await DB.castVote(S.approvalTxn.id, S.myPlayerId, vote);
    await checkVoteOutcome(S.approvalTxn.id);
  } catch (e) { console.error(e); }
  $('btn-approve').disabled = false;
  $('btn-deny').disabled    = false;
}

async function checkVoteOutcome(txnId) {
  const txn = S.pendingTxns.find(t => t.id === txnId);
  if (!txn) { hideApprovalOverlay(); return; }

  const votes     = await DB.getVotes(txnId);
  const eligible  = eligibleVoters(txn);
  const n         = eligible.length;
  const threshold = S.game.approval_threshold;
  const isSpecific = txn.from_player_id && txn.from_player_id !== txn.initiator_id;

  let approved = false, denied = false;

  if (isSpecific) {
    const v = votes.find(vt => vt.player_id === txn.from_player_id);
    if (v?.vote === 'approve') approved = true;
    if (v?.vote === 'deny')    denied   = true;
  } else {
    const approves = votes.filter(v => eligible.includes(v.player_id) && v.vote === 'approve').length;
    const denies   = votes.filter(v => eligible.includes(v.player_id) && v.vote === 'deny').length;
    if (threshold === 'any1') {
      if (approves >= 1)              approved = true;
      if (denies   >= 1)              denied   = true;
    } else if (threshold === 'majority') {
      if (approves > n / 2)           approved = true;
      if (denies   >= Math.ceil(n/2)) denied   = true;
    } else {
      if (approves >= n) approved = true;
      if (denies   >= 1) denied   = true;
    }
  }

  if (denied) {
    await DB.denyTransaction(txnId);
    S.pendingTxns = S.pendingTxns.filter(t => t.id !== txnId);
    hideApprovalOverlay();

  } else if (approved) {
    const won = await DB.approveTransaction(txnId);
    if (won) {
      const freshPlayers = await DB.getPlayers(S.gameId);
      await applyBalances(txn, freshPlayers);
      S.players      = await DB.getPlayers(S.gameId);
      S.transactions = await DB.getRecentTransactions(S.gameId, 5);
      renderGame();
    }
    S.pendingTxns = S.pendingTxns.filter(t => t.id !== txnId);
    hideApprovalOverlay();

  } else {
    if (S.approvalTxn?.id === txnId) {
      $('approval-votes').innerHTML = eligible.map(pid => {
        const v   = votes.find(vt => vt.player_id === pid);
        const cls = v ? (v.vote === 'approve' ? 'yes' : 'no') : 'wait';
        const lbl = v ? (v.vote === 'approve' ? '✓ Yes' : '✗ No') : '…';
        return `<div class="vote-av">
          <div class="av" style="background:${playerColor(pid)}">${playerName(pid)[0].toUpperCase()}</div>
          <div class="vl ${cls}">${lbl}</div>
        </div>`;
      }).join('');
    }
  }
}

// ── Realtime subscriptions ────────────────────────────────────

function subscribe() {
  S.channel = DB.subscribeToGame(S.gameId, {

    onPlayer: async (payload) => {
      if (payload.eventType === 'INSERT') {
        S.players.push(payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const idx = S.players.findIndex(p => p.id === payload.new.id);
        const prev = idx >= 0 ? S.players[idx] : null;

        // Bankruptcy: someone else just went inactive — show the GIF on their phone too
        if (prev?.is_active && payload.new.is_active === false && payload.new.id !== S.myPlayerId) {
          showBankruptcyOverlay(payload.new.name);
        }

        if (idx >= 0) S.players[idx] = { ...S.players[idx], ...payload.new };
        else S.players.push(payload.new);
      }
      if ($('screen-lobby').classList.contains('active')) renderLobbyPlayers();
      else if ($('screen-game').classList.contains('active')) renderGame();
    },

    onTransaction: async (payload) => {
      if (!$('screen-game').classList.contains('active')) return;
      if (payload.eventType === 'INSERT' && payload.new.status === 'pending_approval') {
        S.pendingTxns = await DB.getPendingTransactions(S.gameId);
        renderPendingApprovals();
      } else if (payload.eventType === 'UPDATE') {
        if (payload.new.status !== 'pending_approval') {
          S.pendingTxns = S.pendingTxns.filter(t => t.id !== payload.new.id);
        }
        S.transactions = await DB.getRecentTransactions(S.gameId, 5);
        renderTransactions();
        renderPendingApprovals();
      }
    },

    onVote: async (payload) => {
      const txnId = payload.new?.transaction_id;
      if (!txnId || !S.pendingTxns.some(t => t.id === txnId)) return;
      await checkVoteOutcome(txnId);
    },

    onDiceRoll: async (payload) => {
      if (payload.new.player_id === S.myPlayerId) return;
      S.lastRoll = payload.new;
      const name = playerName(payload.new.player_id);
      await animateDiceRoll(payload.new.die1, payload.new.die2, payload.new.die1 === payload.new.die2, name);
      if ($('screen-game').classList.contains('active')) renderGame();
    },

    onGame: (payload) => {
      S.game = { ...S.game, ...payload.new };
      if (payload.new.status === 'active' && !$('screen-game').classList.contains('active')) {
        showScreen('screen-game');
      }
      if ($('screen-game').classList.contains('active')) renderGame();
    },
  });
}

// ── Boot ──────────────────────────────────────────────────────

init();
