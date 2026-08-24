import React, { useEffect, useMemo, useState } from 'react';
import {
  useGetAnalystDataHealth,
  useGetAnalystMarketResearch,
  useGetAnalystRoundRobinComparison,
  useGetAnalystToday,
  type MarketResearchCandidate,
  type RoundRobinSideComparison,
} from '@workspace/api-client-react';
import { AlertTriangle, CalendarDays, Info, Layers, Plus, RefreshCw, Search, X } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge, Kicker, LoadingPanel, Panel, QueryMessage, ReadinessStrip, SectionHeading, toneFor } from '../App';

type ResearchMarket = Extract<MarketResearchCandidate['market'], 'TB' | 'XBH' | 'WALK' | 'HR' | 'H_R_RBI'>;
type BoardId = 'rr1' | 'rr2' | 'rr3' | 'rr4' | 'rr5';
type CombinationSize = 2 | 3 | 4;

type BoardConfig = {
  id: BoardId;
  label: string;
  description: string;
  activeMarkets: ResearchMarket[];
  unavailableMarket?: string;
  exposureOptIn?: boolean;
};

const BOARDS: BoardConfig[] = [
  {
    id: 'rr1',
    label: 'RR1 · TB + TB',
    description: 'Two different-player 2+ Total Bases legs from the usable research universe.',
    activeMarkets: ['TB'],
  },
  {
    id: 'rr2',
    label: 'RR2 · TB + Walk',
    description: '2+ Total Bases and 1+ Batter Walk legs. Select only the evidence available for this slate.',
    activeMarkets: ['TB', 'WALK'],
  },
  {
    id: 'rr3',
    label: 'RR3 · XBH + H+R+RBI',
    description: '1+ Extra Base Hit + 2+ H+R+RBI. Both legs require current, source-backed research for the same team.',
    activeMarkets: ['XBH', 'H_R_RBI'],
  },
  {
    id: 'rr4',
    label: 'RR4 · XBH + Walk',
    description: '1+ Extra Base Hit and 1+ Batter Walk legs. Same-player mixed-market exposure requires an explicit opt-in.',
    activeMarkets: ['XBH', 'WALK'],
    exposureOptIn: true,
  },
  {
    id: 'rr5',
    label: 'RR5 · All / General',
    description: 'Chooses the strongest legal same-team construction from RR1 through RR4; no additional pair type is introduced.',
    activeMarkets: ['TB', 'XBH', 'WALK', 'H_R_RBI'],
  },
];

const MARKET_LABELS: Record<ResearchMarket, string> = {
  TB: '2+ Total Bases',
  XBH: '1+ Extra Base Hit',
  WALK: '1+ Batter Walk',
  H_R_RBI: '2+ H+R+RBI',
  HR: '1+ Home Run',
};

const SELECTION_BLOCK_LABELS: Record<NonNullable<MarketResearchCandidate['selectionBlockReason']>, string> = {
  BLOCKED: 'BLOCKED',
  NEGATIVE: 'NEGATIVE',
  STALE: 'STALE EVIDENCE',
  UNRESOLVED_IDENTITY: 'IDENTITY UNRESOLVED',
  INCOMPLETE_EVIDENCE: 'INCOMPLETE EVIDENCE',
};

function currentEasternDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function combinationPreview<T>(values: T[], size: number, limit = 20): T[][] {
  const output: T[][] = [];
  const build = (start: number, remaining: number, current: T[]) => {
    if (output.length >= limit) return;
    if (remaining === 0) {
      output.push(current);
      return;
    }
    for (let index = start; index <= values.length - remaining && output.length < limit; index += 1) {
      build(index + 1, remaining - 1, [...current, values[index]]);
    }
  };
  build(0, size, []);
  return output;
}

function combinationCount(n: number, k: number) {
  if (n < k || k < 1) return 0;
  let value = 1;
  for (let index = 1; index <= k; index += 1) value = (value * (n - index + 1)) / index;
  return Math.round(value);
}

function createEmptyTrays(): Record<BoardId, MarketResearchCandidate[]> {
  return { rr1: [], rr2: [], rr3: [], rr4: [], rr5: [] };
}

function evidenceKeys(value: Record<string, unknown>) {
  const keys = Object.keys(value).slice(0, 3);
  return keys.length ? keys.map((key) => key.replaceAll(/([A-Z])/g, ' $1').trim()).join(' · ') : 'NOT FOUND';
}

function baselineRank(candidate: Pick<MarketResearchCandidate, 'opportunityEvidence'>) {
  const direct = candidate.opportunityEvidence?.baselineRank;
  const nested = candidate.opportunityEvidence?.baseline;
  const value = typeof direct === 'number'
    ? direct
    : nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).baselineRank === 'number'
      ? (nested as Record<string, unknown>).baselineRank
      : null;
  return typeof value === 'number' ? value : null;
}

function SideConstruction({ side, selected }: { side: RoundRobinSideComparison; selected: boolean }) {
  const construction = side.bestConstruction;
  return (
    <article className={selected ? 'round-robin-side-card selected' : 'round-robin-side-card'} data-testid={`round-robin-side-${side.side.toLowerCase()}`}>
      <header>
        <div><Kicker>{side.side} · {side.team}</Kicker><strong>{construction?.constructionLabel ?? 'No legal construction'}</strong></div>
        {selected && <Badge tone="good">Selected</Badge>}
      </header>
      <p className="round-robin-side-count">{side.evaluatedEligibleHitters} eligible · {side.evaluatedIneligibleHitters} blocked for safety</p>
      {!!side.consideredConstructionTypes.length && <p className="round-robin-side-count">Compared: {side.consideredConstructionTypes.map((type) => type.replaceAll('_', ' + ')).join(' · ')}</p>}
      {construction ? (
        <>
          <ol className="round-robin-comparison-legs">
            {construction.legs.map((leg) => (
              <li key={leg.candidateId}>
                <div>
                  <strong>{leg.playerName}</strong>
                  <span>
                    <Badge tone="accent">{MARKET_LABELS[leg.market as ResearchMarket]}</Badge>{' '}
                    <Badge tone={toneFor(leg.researchState)}>{leg.researchState}</Badge>{' '}
                    <small>baseline {baselineRank(leg) ?? '—'} · research {leg.researchRank ?? '—'}</small>
                  </span>
                </div>
                <p>
                  {leg.lineupState} lineup · {leg.starterState} starter · BvP {leg.bvpEvidence?.status ?? 'NOT FOUND'} · arsenal {leg.arsenalStatus} · freshness {leg.evidenceFreshness}
                </p>
                <small>
                  Opportunity: {evidenceKeys(leg.opportunityEvidence)} · bullpen: {evidenceKeys(leg.bullpenPathEvidence)} · park: {evidenceKeys(leg.parkEvidence)} · counter: {evidenceKeys(leg.counterEvidence)}
                </small>
                <small>Lineage: {Object.entries(leg.sourceLineage).map(([key, value]) => `${key}=${String(value)}`).join(' · ')} · samples: {Object.entries(leg.sampleDenominators).map(([key, value]) => `${key}=${String(value ?? 'not found')}`).join(' · ')}</small>
                {construction.legCases.filter((item) => item.candidateId === leg.candidateId).map((item) => (
                  <small key={String(item.candidateId)}>Case: {String(item.caseFor)} {String(item.counterCase)} {String(item.missingOrStale)}</small>
                ))}
              </li>
            ))}
          </ol>
          <p className="round-robin-comparison-summary">{construction.evidenceSummary}</p>
          <p className="round-robin-comparison-summary">{construction.sharedMechanism}{construction.geometry ? ` · ${construction.geometry}` : ''}</p>
          {!!construction.rejectedAlternatives.length && <p className="round-robin-comparison-summary">Rejected alternatives: {construction.rejectedAlternatives.join(' · ')}</p>}
        </>
      ) : (
        <div className="round-robin-missing" data-testid={`round-robin-availability-${side.side.toLowerCase()}`}>
          <strong>{side.availabilityStatus.replaceAll("_", " ")}</strong>
          <p>{side.availabilityDetail ?? side.unavailableReason} {side.noPairCauses.join(' · ')}</p>
        </div>
      )}
    </article>
  );
}

export default function RoundRobinPage() {
  const [date, setDate] = useState(currentEasternDate);
  const [activeBoardId, setActiveBoardId] = useState<BoardId>('rr1');
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [gameFilter, setGameFilter] = useState('');
  const [combinationSize, setCombinationSize] = useState<CombinationSize>(2);
  const [trays, setTrays] = useState<Record<BoardId, MarketResearchCandidate[]>>(createEmptyTrays);
  const [pendingCandidate, setPendingCandidate] = useState<MarketResearchCandidate | null>(null);

  const researchQuery = useGetAnalystMarketResearch({ date });
  const slateQuery = useGetAnalystToday({ date });
  const healthQuery = useGetAnalystDataHealth({ date });
  const activeBoard = BOARDS.find((board) => board.id === activeBoardId) ?? BOARDS[0];
  const manualConstructionDisabled = true;
  const comparisonQuery = useGetAnalystRoundRobinComparison({ date, board: activeBoardId.toUpperCase() as 'RR1' | 'RR2' | 'RR3' | 'RR4' | 'RR5' });
  const candidates = researchQuery.data?.candidates ?? [];
  const games = slateQuery.data?.games ?? [];
  const candidatesById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.candidateId, candidate])),
    [candidates],
  );
  const tray = useMemo(
    () => manualConstructionDisabled ? [] : trays[activeBoardId]
      .map((leg) => candidatesById.get(leg.candidateId))
      .filter((leg): leg is MarketResearchCandidate => Boolean(leg?.selectable)),
    [activeBoardId, candidatesById, manualConstructionDisabled, trays],
  );
  const selectableCandidateCount = useMemo(
    () => candidates.filter((candidate) => candidate.selectable).length,
    [candidates],
  );

  useEffect(() => {
    setTrays((current) => {
      let changed = false;
      const next = { ...current };

      for (const boardId of Object.keys(current) as BoardId[]) {
        const currentTray = current[boardId];
        const refreshedTray = currentTray
          .map((leg) => candidatesById.get(leg.candidateId))
          .filter((leg): leg is MarketResearchCandidate => Boolean(leg?.selectable));

        if (refreshedTray.length !== currentTray.length
          || refreshedTray.some((leg, index) => leg.candidateId !== currentTray[index]?.candidateId)) {
          next[boardId] = refreshedTray;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [candidatesById]);

  useEffect(() => {
    if (pendingCandidate && !candidatesById.get(pendingCandidate.candidateId)?.selectable) {
      setPendingCandidate(null);
    }
  }, [candidatesById, pendingCandidate]);

  const gamesById = useMemo(
    () => new Map(games.map((game) => [game.id, game])),
    [games],
  );

  const teamOptions = useMemo(
    () => Array.from(new Set(games.flatMap((game) => [game.away, game.home]))).sort(),
    [games],
  );

  const filteredCandidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    return candidates
      .filter((candidate) => activeBoard.activeMarkets.includes(candidate.market as ResearchMarket))
      .filter((candidate) => !term || candidate.playerName.toLowerCase().includes(term) || candidate.market.toLowerCase().includes(term))
      .filter((candidate) => {
        const game = gamesById.get(String(candidate.gamePk));
        return !teamFilter || game?.away === teamFilter || game?.home === teamFilter;
      })
      .filter((candidate) => !gameFilter || String(candidate.gamePk) === gameFilter)
      .sort((a, b) => (a.researchRank ?? Number.MAX_SAFE_INTEGER) - (b.researchRank ?? Number.MAX_SAFE_INTEGER));
  }, [activeBoard.activeMarkets, candidates, gameFilter, gamesById, search, teamFilter]);

  const generatedCombinations = useMemo(() => combinationPreview(tray, combinationSize), [combinationSize, tray]);
  const totalCombinations = combinationCount(tray.length, combinationSize);
  const activeHealth = healthQuery.data;

  const gameLabel = (candidate: MarketResearchCandidate) => {
    const game = gamesById.get(String(candidate.gamePk));
    return game ? `${game.away} @ ${game.home}` : `Game ${candidate.gamePk}`;
  };

  const updateActiveTray = (updater: (current: MarketResearchCandidate[]) => MarketResearchCandidate[]) => {
    setTrays((current) => ({ ...current, [activeBoardId]: updater(current[activeBoardId]) }));
  };

  const addCandidate = (candidate: MarketResearchCandidate) => {
    if (manualConstructionDisabled) return;
    const currentCandidate = candidatesById.get(candidate.candidateId);
    if (!currentCandidate?.selectable) return;
    if (tray.some((leg) => leg.playerId === currentCandidate.playerId && leg.market === currentCandidate.market)) return;

    const mixedSamePlayer = activeBoard.exposureOptIn
      && ['XBH', 'WALK'].includes(currentCandidate.market)
      && tray.some((leg) => leg.playerId === currentCandidate.playerId && leg.market !== currentCandidate.market && ['XBH', 'WALK'].includes(leg.market));

    if (mixedSamePlayer) {
      setPendingCandidate(currentCandidate);
      return;
    }

    updateActiveTray((current) => [...current, currentCandidate]);
  };

  const switchBoard = (boardId: BoardId) => {
    setActiveBoardId(boardId);
    setSearch('');
    setTeamFilter('');
    setGameFilter('');
    setCombinationSize(2);
  };

  const changeDate = (nextDate: string) => {
    if (!nextDate || nextDate === date) return;
    setDate(nextDate);
    setTrays(createEmptyTrays());
    setSearch('');
    setTeamFilter('');
    setGameFilter('');
    setCombinationSize(2);
    setPendingCandidate(null);
  };

  return (
    <div className="page-content rise-in" data-testid="round-robin-page">
      <div className="page-intro">
        <div>
          <Kicker>Analysis boards / read-only research</Kicker>
          <h1>Round Robin <span className="slash">//</span> workspace</h1>
          <p>Construct market-specific research combinations from the active MLB slate using only source-backed player context.</p>
        </div>
        <button className="button button-dark" onClick={() => researchQuery.refetch()} disabled={researchQuery.isFetching} data-testid="button-refresh-round-robin">
          <RefreshCw size={15} className={researchQuery.isFetching ? 'animate-spin' : ''} />
          {researchQuery.isFetching ? 'Refreshing…' : 'Refresh research'}
        </button>
      </div>

      <div className="round-robin-context">
        <label>
          <span><CalendarDays size={13} /> Active slate date</span>
          <input type="date" value={date} onChange={(event) => changeDate(event.target.value)} data-testid="input-round-robin-date" />
        </label>
        <div>
          <span>Viewing</span>
          <strong>{date} ET</strong>
        </div>
        <div>
          <span>Research context</span>
          <Badge tone={toneFor(activeHealth?.readiness.status ?? 'NOT RUN')}>{activeHealth?.readiness.status ?? 'NOT RUN'}</Badge>
        </div>
        <div>
          <span>Usable records</span>
          <strong>{selectableCandidateCount.toLocaleString()}</strong>
        </div>
      </div>
      <ReadinessStrip health={activeHealth} />

      <div className="round-robin-tabs" role="tablist" aria-label="Round Robin boards">
        {BOARDS.map((board) => (
          <button
            key={board.id}
            className={activeBoardId === board.id ? 'round-robin-tab active' : 'round-robin-tab'}
            onClick={() => switchBoard(board.id)}
            role="tab"
            aria-selected={activeBoardId === board.id}
            data-testid={`tab-${board.id}`}
          >
            {board.label}
          </button>
        ))}
      </div>

      <div className="round-robin-layout">
        <div className="round-robin-main">
          <Panel>
            <SectionHeading eyebrow="Board rules" title={activeBoard.label} detail={activeBoard.description} />
            <div className="round-robin-rulebar">
              <span>Available: {activeBoard.activeMarkets.map((market) => MARKET_LABELS[market]).join(' · ')}</span>
              {activeBoard.unavailableMarket && <Badge tone="warn">{activeBoard.unavailableMarket} · UNSUPPORTED / NOT EVALUATED</Badge>}
              {activeBoard.exposureOptIn && <span>Same-player XBH + Walk needs opt-in</span>}
            </div>
          </Panel>

          {activeBoard.unavailableMarket && (
            <div className="round-robin-notice" data-testid="msg-not-evaluated">
              <Info size={16} />
              <div><strong>{activeBoard.unavailableMarket} — UNSUPPORTED</strong><p>This companion market has no current usable research contract, so it cannot be selected or fabricated on this board.</p></div>
            </div>
          )}

          <Panel className="round-robin-comparisons">
            <SectionHeading eyebrow="Both-team game comparison" title="Best legal construction by side" detail="Both offenses are evaluated before a side is selected. Baseline ranks remain audit-visible while optional enrichment is incomplete; safety-blocked rows cannot enter a construction." />
            {comparisonQuery.isLoading ? <LoadingPanel rows={3} /> : comparisonQuery.isError ? (
              <QueryMessage kind="error" onRetry={() => comparisonQuery.refetch()} />
            ) : !comparisonQuery.data?.games.length ? (
              <div className="round-robin-empty"><Info size={18} /><div><strong>NOT EVALUATED</strong><p>No games are available for this slate date.</p></div></div>
            ) : (
              <div className="round-robin-comparison-list" data-testid="round-robin-team-comparisons">
                {comparisonQuery.data.games.map((game) => (
                  <article className="round-robin-game-comparison" key={game.gamePk} data-testid={`round-robin-game-comparison-${game.gamePk}`}>
                    <header>
                      <div><Kicker>Game {game.gamePk}</Kicker><h3>{game.away.team} @ {game.home.team}</h3></div>
                      {game.selectedConstruction
                        ? <Badge tone="good">{game.selectedSide} selected · {game.selectedConstruction.constructionLabel}</Badge>
                        : <Badge tone="warn">No selected side</Badge>}
                    </header>
                    <div className="round-robin-side-grid">
                      <SideConstruction side={game.away} selected={game.selectedSide === 'AWAY'} />
                      <SideConstruction side={game.home} selected={game.selectedSide === 'HOME'} />
                    </div>
                    <p className="round-robin-comparison-reason"><strong>Comparison:</strong> {game.comparisonReason}</p>
                    {!!game.evidenceGaps.length && <p className="round-robin-comparison-reason"><strong>Evidence gaps:</strong> {game.evidenceGaps.join(' · ')}</p>}
                    {!!game.noPairCauses.length && <p className="round-robin-comparison-reason"><strong>Availability causes:</strong> {game.noPairCauses.join(' · ')}</p>}
                  </article>
                ))}
              </div>
            )}
          </Panel>

          <Panel className="round-robin-candidates">
            <SectionHeading eyebrow="Player research" title="Add a leg" detail="All research stays visible for audit. Only rows with complete, current evidence can be selected." />
            <div className="round-robin-filters">
              <label className="round-robin-search">
                <Search size={14} />
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search player or market" data-testid="input-round-robin-search" />
              </label>
              <select value={teamFilter} onChange={(event) => setTeamFilter(event.target.value)} data-testid="select-round-robin-team">
                <option value="">All slate teams</option>
                {teamOptions.map((team) => <option key={team} value={team}>{team}</option>)}
              </select>
              <select value={gameFilter} onChange={(event) => setGameFilter(event.target.value)} data-testid="select-round-robin-game">
                <option value="">All games</option>
                {games.map((game) => <option key={game.id} value={game.id}>{game.away} @ {game.home}</option>)}
              </select>
            </div>

            {researchQuery.isLoading ? (
              <div className="round-robin-state"><LoadingPanel rows={5} /></div>
            ) : researchQuery.isError ? (
              <div className="round-robin-state"><QueryMessage kind="error" onRetry={() => researchQuery.refetch()} /></div>
            ) : candidates.length === 0 ? (
              <div className="round-robin-empty" data-testid="round-robin-not-found">
                <AlertTriangle size={18} />
                <div><strong>NOT EVALUATED</strong><p>No usable market research records exist for {date} ET. Add research records before selecting legs for this board.</p></div>
              </div>
            ) : filteredCandidates.length === 0 ? (
              <div className="round-robin-empty">
                <Search size={18} />
                <div><strong>NOT FOUND</strong><p>Research exists for the slate, but no records match these filters.</p></div>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table" data-testid="round-robin-candidate-table">
                  <thead>
                    <tr><th>Player</th><th>Game</th><th>Leg</th><th>Baseline / research</th><th>Why / availability</th><th>Named matchup</th><th className="number">Action</th></tr>
                  </thead>
                  <tbody>
                    {filteredCandidates.map((candidate) => {
                      const alreadyAdded = tray.some((leg) => leg.playerId === candidate.playerId && leg.market === candidate.market);
                      const selectionBlockLabel = candidate.selectable
                        ? null
                        : SELECTION_BLOCK_LABELS[candidate.selectionBlockReason!];
                      return (
                        <tr key={candidate.candidateId} data-testid={`row-round-robin-${candidate.playerId}-${candidate.market}`}>
                          <td><strong>{candidate.playerName}</strong></td>
                          <td className="text-xs">{gameLabel(candidate)}</td>
                          <td><Badge tone="accent">{MARKET_LABELS[candidate.market as ResearchMarket]}</Badge></td>
                          <td>
                            <Badge tone={toneFor(candidate.researchState)}>{candidate.researchState}</Badge>
                            <small className="round-robin-missing"> baseline {baselineRank(candidate) ?? '—'} · research {candidate.researchRank ?? '—'}</small>
                            {baselineRank(candidate) !== null && candidate.researchRank !== null && baselineRank(candidate) !== candidate.researchRank && (
                              <small className="round-robin-missing"> · DISAGREEMENT: optional research changed the ordinal order</small>
                            )}
                          </td>
                          <td className="text-xs">
                            <span>{candidate.primaryMechanism?.replaceAll('_', ' ') ?? 'NOT FOUND'}</span>
                            {candidate.missingStaleEvidence && <small className="round-robin-missing"> · {candidate.missingStaleEvidence}</small>}
                            {selectionBlockLabel && <small className="round-robin-missing"> · {selectionBlockLabel}</small>}
                            {candidate.auditReason && <small className="round-robin-missing"> · {candidate.auditReason}</small>}
                          </td>
                           <td className="text-xs" data-testid={`bvp-round-robin-${candidate.playerId}-${candidate.market}`}>
                             {candidate.bvpEvidence ? (
                               <>
                                 <Badge tone={candidate.bvpEvidence.status === 'AVAILABLE' ? 'neutral' : 'warn'}>
                                   BvP · {candidate.bvpEvidence.sampleBand.replaceAll('_', ' ')}
                                 </Badge>
                                 <small className="round-robin-missing"> {candidate.bvpEvidence.pa} PA · {candidate.bvpEvidence.arsenal.status === 'AVAILABLE' ? 'arsenal compared' : 'arsenal limited'}</small>
                               </>
                             ) : <span>NOT FOUND</span>}
                           </td>
                          <td className="number">
                            <button
                              className="button button-quiet round-robin-add"
                              onClick={() => addCandidate(candidate)}
                               disabled={manualConstructionDisabled || alreadyAdded || !candidate.selectable}
                               title={manualConstructionDisabled ? 'Read-only board: use the audited two-team comparison above.' : selectionBlockLabel ? `Not selectable: ${selectionBlockLabel}` : undefined}
                              data-testid={`button-add-leg-${candidate.playerId}-${candidate.market}`}
                            >
                               <Plus size={13} /> {manualConstructionDisabled ? 'Read only' : alreadyAdded ? 'Added' : candidate.selectable ? 'Add' : 'Unavailable'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <aside className="round-robin-tray">
          <Panel>
            <SectionHeading
              eyebrow="Selected-leg tray"
              title={`${tray.length} ${tray.length === 1 ? 'leg' : 'legs'}`}
              detail="Selections remain separated by board."
              action={tray.length ? <button className="button button-quiet" onClick={() => updateActiveTray(() => [])} data-testid="button-clear-round-robin">Clear</button> : undefined}
            />
            <div className="round-robin-tray-body">
              {manualConstructionDisabled ? (
                <div className="round-robin-tray-empty"><Layers size={21} /><p>Read-only board. The audited two-team constructions above are the only selectable game results.</p></div>
              ) : !tray.length ? (
                <div className="round-robin-tray-empty"><Layers size={21} /><p>Add eligible player legs to build combinations.</p></div>
              ) : (
                <ol className="round-robin-legs">
                  {tray.map((leg, index) => {
                    const samePlayerExposure = activeBoard.exposureOptIn
                      && tray.some((other, otherIndex) => otherIndex !== index && other.playerId === leg.playerId && other.market !== leg.market);
                    return (
                      <li key={`${leg.candidateId}-${index}`}>
                        <div>
                          <strong>{leg.playerName}</strong>
                          <span>{gameLabel(leg)}</span>
                          <div><Badge tone="accent">{MARKET_LABELS[leg.market as ResearchMarket]}</Badge> <Badge tone={toneFor(leg.researchState)}>{leg.researchState}</Badge></div>
                          {samePlayerExposure && <small className="round-robin-exposure">Same-player mixed-market exposure allowed</small>}
                        </div>
                        <button className="icon-button" onClick={() => updateActiveTray((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`Remove ${leg.playerName}`} data-testid={`button-remove-round-robin-leg-${index}`}><X size={13} /></button>
                      </li>
                    );
                  })}
                </ol>
              )}

              {!manualConstructionDisabled && <div className="round-robin-combinations">
                <Kicker>Combination builder</Kicker>
                <div className="round-robin-size-selector" role="group" aria-label="Combination size">
                  {([2, 3, 4] as CombinationSize[]).map((size) => (
                    <button key={size} className={combinationSize === size ? 'active' : ''} onClick={() => setCombinationSize(size)} disabled={tray.length < size} data-testid={`button-round-robin-${size}s`}>
                      {size}s
                    </button>
                  ))}
                </div>
                <div className="round-robin-combination-summary">
                  <strong>{totalCombinations.toLocaleString()}</strong>
                  <span>{combinationSize}-leg combinations from {tray.length} selected legs</span>
                </div>
                {totalCombinations > 0 ? (
                  <>
                    <ol className="round-robin-combination-list" data-testid="round-robin-combination-list">
                      {generatedCombinations.slice(0, 20).map((combination, index) => (
                        <li key={combination.map((leg) => leg.candidateId).join('-')}>
                          <span>{index + 1}</span>
                          <p>{combination.map((leg) => `${leg.playerName} · ${MARKET_LABELS[leg.market as ResearchMarket]}`).join('  +  ')}</p>
                        </li>
                      ))}
                    </ol>
                    {totalCombinations > 20 && <p className="round-robin-list-note">Showing the first 20 of {totalCombinations.toLocaleString()} generated combinations.</p>}
                  </>
                ) : (
                  <p className="round-robin-list-note">Add at least {combinationSize} legs to generate combinations.</p>
                )}
              </div>}
            </div>
          </Panel>
        </aside>
      </div>

      <AlertDialog open={Boolean(pendingCandidate)} onOpenChange={(open) => !open && setPendingCandidate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Same-player multi-market exposure</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCandidate?.playerName} is already selected for the other XBH/Walk market. Adding this leg creates same-player exposure in RR4. This is allowed only with your explicit opt-in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingCandidate(null)}>Keep separate</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const currentCandidate = pendingCandidate
                ? candidatesById.get(pendingCandidate.candidateId)
                : undefined;
              if (currentCandidate?.selectable) {
                updateActiveTray((current) => [...current, currentCandidate]);
              }
              setPendingCandidate(null);
            }}>Allow exposure</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
