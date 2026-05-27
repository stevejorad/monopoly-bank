// ═══════════════════════════════════════════════════════════════
// db.js — Supabase client and all database operations
// ═══════════════════════════════════════════════════════════════
//
// Get these values from: https://app.supabase.com
//   → your project → Settings → API
//
const SUPABASE_URL      = 'https://hsijsmlerascsydyvjxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_i_lN8kSSWVRrxdEEgMZfIw_ZWDvOakQ';
// ───────────────────────────────────────────────────────────────

const { createClient } = supabase;
const _db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DB = {

  // ── Games ─────────────────────────────────────────────────────

  async createGame(id, startingBalance, approvalThreshold) {
    const { data, error } = await _db.from('games')
      .insert({ id, starting_balance: startingBalance, approval_threshold: approvalThreshold })
      .select().single();
    if (error) throw error;
    return data;
  },

  async getGame(id) {
    const { data, error } = await _db.from('games')
      .select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  },

  async startGame(gameId, firstPlayerId) {
    const { error } = await _db.from('games')
      .update({ status: 'active', current_turn_id: firstPlayerId })
      .eq('id', gameId);
    if (error) throw error;
  },

  async advanceTurn(gameId, nextPlayerId) {
    const { error } = await _db.from('games')
      .update({ current_turn_id: nextPlayerId })
      .eq('id', gameId);
    if (error) throw error;
  },

  // ── Players ───────────────────────────────────────────────────

  async addPlayer(gameId, name, balance) {
    const { data, error } = await _db.from('players')
      .insert({ game_id: gameId, name, balance })
      .select().single();
    if (error) throw error;
    return data;
  },

  async getPlayers(gameId) {
    const { data, error } = await _db.from('players')
      .select('*').eq('game_id', gameId)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
  },

  async updateBalance(playerId, newBalance) {
    const { error } = await _db.from('players')
      .update({ balance: newBalance }).eq('id', playerId);
    if (error) throw error;
  },

  async setTurnOrder(players) {
    await Promise.all(
      players.map(p => _db.from('players').update({ turn_order: p.turn_order }).eq('id', p.id))
    );
  },

  // ── Transactions ──────────────────────────────────────────────

  async createTransaction(txn) {
    const { data, error } = await _db.from('transactions')
      .insert(txn).select().single();
    if (error) throw error;
    return data;
  },

  async getTransactionById(txnId) {
    const { data, error } = await _db.from('transactions')
      .select('*').eq('id', txnId).single();
    if (error) throw error;
    return data;
  },

  async getRecentTransactions(gameId, limit = 20) {
    const { data, error } = await _db.from('transactions')
      .select(`
        *,
        initiator:players!initiator_id(name),
        from_player:players!from_player_id(name),
        to_player:players!to_player_id(name)
      `)
      .eq('game_id', gameId)
      .in('status', ['completed', 'approved'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },

  async getPendingTransactions(gameId) {
    const { data, error } = await _db.from('transactions')
      .select(`*, initiator:players!initiator_id(id, name)`)
      .eq('game_id', gameId)
      .eq('status', 'pending_approval');
    if (error) throw error;
    return data ?? [];
  },

  // Returns true if this client won the race to approve (prevents double execution)
  async approveTransaction(txnId) {
    const { data } = await _db.from('transactions')
      .update({ status: 'approved' })
      .eq('id', txnId)
      .eq('status', 'pending_approval') // only succeeds if still pending
      .select();
    return (data?.length ?? 0) > 0;
  },

  async denyTransaction(txnId) {
    await _db.from('transactions')
      .update({ status: 'denied' })
      .eq('id', txnId)
      .eq('status', 'pending_approval');
  },

  // ── Votes ──────────────────────────────────────────────────────

  async castVote(transactionId, playerId, vote) {
    const { error } = await _db.from('votes')
      .upsert(
        { transaction_id: transactionId, player_id: playerId, vote },
        { onConflict: 'transaction_id,player_id' }
      );
    if (error) throw error;
  },

  async getVotes(transactionId) {
    const { data, error } = await _db.from('votes')
      .select('*').eq('transaction_id', transactionId);
    if (error) throw error;
    return data ?? [];
  },

  // ── Dice ───────────────────────────────────────────────────────

  async recordRoll(gameId, playerId, die1, die2) {
    const { error } = await _db.from('dice_rolls')
      .insert({ game_id: gameId, player_id: playerId, die1, die2 });
    if (error) throw error;
  },

  async getLastRoll(gameId) {
    const { data } = await _db.from('dice_rolls')
      .select('*, player:players(name)')
      .eq('game_id', gameId)
      .order('rolled_at', { ascending: false })
      .limit(1).single();
    return data ?? null;
  },

  // ── Realtime ───────────────────────────────────────────────────

  subscribeToGame(gameId, handlers) {
    return _db.channel(`game:${gameId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'players',
        filter: `game_id=eq.${gameId}`
      }, handlers.onPlayer)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'transactions',
        filter: `game_id=eq.${gameId}`
      }, handlers.onTransaction)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'votes'
        // No game_id filter on votes (votes table doesn't have game_id);
        // we filter client-side by checking pending transaction IDs
      }, handlers.onVote)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'dice_rolls',
        filter: `game_id=eq.${gameId}`
      }, handlers.onDiceRoll)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'games',
        filter: `id=eq.${gameId}`
      }, handlers.onGame)
      .subscribe();
  },

  unsubscribe(channel) {
    if (channel) _db.removeChannel(channel);
  }
};
