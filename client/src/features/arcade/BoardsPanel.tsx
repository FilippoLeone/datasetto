import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '@/components';
import type { GameMeta } from '@/arcade/catalog';
import type { GameId } from '@/arcade/runtime/types';
import { users } from '@/state/presence';
import { fetchBoard, listBoards, refusalText, type BoardRow } from './api';
import { Pills } from './LobbyForm';

/**
 * Leaderboards (platform.md §11.3): pick a game and a board; names come from presence, so people
 * who are not online show as "Player". Only games with at least two humans count.
 */
export const BoardsPanel = ({ games }: { games: readonly GameMeta[] }) => {
  const [game, setGame] = useState<GameId | null>(games[0]?.id ?? null);
  const [boards, setBoards] = useState<{ id: string; label: string }[] | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!game) return;
    let alive = true;
    setBoards(null);
    setBoard(null);
    setRows(null);
    void listBoards(game).then((answer) => {
      if (!alive) return;
      if (!answer.ok) return setError(refusalText(answer.code));
      setError(null);
      setBoards(answer.boards);
      setBoard(answer.boards[0]?.id ?? null);
    });
    return () => {
      alive = false;
    };
  }, [game]);

  useEffect(() => {
    if (!game || !board) return;
    let alive = true;
    setRows(null);
    void fetchBoard(game, board).then((answer) => {
      if (!alive) return;
      if (!answer.ok) return setError(refusalText(answer.code));
      setRows(answer.rows);
    });
    return () => {
      alive = false;
    };
  }, [game, board]);

  if (games.length === 0) return <p className="px-3 py-2 text-sm text-text-muted">No online games yet.</p>;
  const names = new Map(users.value.map((user) => [user.accountId, user.displayName]));
  return (
    <div className="flex flex-col gap-3 px-3 py-2" data-arcade-boards>
      {games.length > 1 && <Pills label="Game" choices={games.map((meta) => ({ value: meta.id, label: meta.name }))} value={game} onPick={(v) => setGame(v as GameId)} />}
      {boards && boards.length > 1 && <Pills label="Board" choices={boards.map((b) => ({ value: b.id, label: b.label }))} value={board} onPick={(v) => setBoard(String(v))} />}
      {error && (
        <p className="text-sm text-[#fa777c]" role="alert">
          {error}
        </p>
      )}
      {!error && boards?.length === 0 && <p className="text-sm text-text-muted">This game keeps no boards.</p>}
      {!error && (boards === null || (board && rows === null)) && <Spinner size={20} />}
      {rows && (
        <ol className="flex flex-col">
          {rows.length === 0 && <li className="text-sm text-text-muted">Nobody is on this board yet.</li>}
          {rows.map((row, i) => (
            <li key={row.a} className="flex min-h-8 items-center gap-2 text-sm" data-arcade-board-row>
              <span className="w-6 shrink-0 text-right text-xs text-text-muted tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-text-bright">{names.get(row.a) ?? 'Player'}</span>
              {row.l && <span className="shrink-0 truncate text-xs text-text-muted">{row.l}</span>}
              <span className="shrink-0 tabular-nums">{row.v.toLocaleString()}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
