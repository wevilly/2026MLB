const fs = require('fs');

const path = 'artifacts/mlb-analyst/src/App.tsx';
let content = fs.readFileSync(path, 'utf8');

const newComponent = `
function BettorIntelligencePage() {
  const [sourceId, setSourceId] = useState('');
  const [market, setMarket] = useState<BettorEvaluationPickMarket | ''>('');

  const query = useGetAnalystBettorEvaluation({
    sourceId: sourceId || undefined,
    market: market || undefined
  });

  const data = query.data as BettorEvaluation | undefined;

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Observational analysis</Kicker>
          <h1>Bettor <span className="slash">//</span> intelligence</h1>
          <p>
            Evaluation is observational only and never changes model training or confidence labels.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="select-wrap relative w-48">
            <select value={sourceId} onChange={e => setSourceId(e.target.value)} data-testid="select-source">
              <option value="">All Sources</option>
              {data?.sources?.map(s => <option key={s.sourceId} value={s.sourceId}>{s.accountHandle}</option>)}
            </select>
          </div>
          <div className="select-wrap relative w-48">
            <select value={market} onChange={e => setMarket(e.target.value as any)} data-testid="select-market">
              <option value="">All Markets</option>
              <option value="TB">TB</option>
              <option value="XBH">XBH</option>
              <option value="WALK">WALK</option>
              <option value="HR">HR</option>
            </select>
          </div>
          <button className="button button-dark" onClick={() => query.refetch()} disabled={query.isRefetching} data-testid="button-refresh">
            <RefreshCw size={15} className={query.isRefetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {query.isLoading ? <LoadingPanel rows={6} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <div className="metric-grid">
            <Metric label="Total sources" value={data.sources.length} note="Tracked" tone="neutral" />
            <Metric label="Total records" value={data.totalRecords} note="Aggregated" tone="neutral" />
            <Metric label="Total picks" value={data.totalPicks} note="Ingested" tone="neutral" />
            <Metric label="Evaluation Window" value={data.evaluationWindow} note={data.computedAt.slice(11, 16) + 'z'} tone="accent" />
          </div>

          <Panel className="mb-6">
            <SectionHeading eyebrow="Source Comparison" title="Leaderboard & Mechanism Breakdown" detail="Aggregated performance by source, market, and primary mechanism." />
            {data.records.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Platform</th>
                      <th>Market</th>
                      <th>Mechanism</th>
                      <th className="number">Picks</th>
                      <th className="number">Settled</th>
                      <th className="number">Outcome Rate</th>
                      <th className="number">Delta</th>
                      <th className="number">Indep. Score</th>
                      <th className="number">Adj. Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map(record => (
                      <tr key={record.performanceRecordId} data-testid={"record-" + record.performanceRecordId}>
                        <td><strong>{record.source.accountHandle}</strong></td>
                        <td>{record.source.platform}</td>
                        <td className="market-cell">{record.market}</td>
                        <td><Badge tone="neutral">{record.mechanism}</Badge></td>
                        <td className="number">{record.pickCount}</td>
                        <td className="number">{record.settledPickCount}</td>
                        <td className="number">{(record.outcomeRate * 100).toFixed(1)}%</td>
                        <td className="number">
                          <span className={record.baseRateDelta > 0 ? 'text-accent' : record.baseRateDelta < 0 ? 'text-destructive' : ''}>
                            {record.baseRateDelta > 0 ? '+' : ''}{(record.baseRateDelta * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="number">{(record.independenceScore * 100).toFixed(0)}%</td>
                        <td className="number">{record.duplicationAdjustedCount.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <QueryMessage kind="empty" />}
          </Panel>

          <Panel>
            <SectionHeading eyebrow="Pick History" title="Settled vs Predicted" detail="Line-item historical evidence and copy-detection flags." />
            {data.picks.length > 0 ? (
               <div className="table-wrap">
               <table className="data-table">
                 <thead>
                   <tr>
                     <th>Date</th>
                     <th>Player</th>
                     <th>Market</th>
                     <th>Direction</th>
                     <th>Mechanism</th>
                     <th>Source</th>
                     <th>Duplication</th>
                     <th>Prediction</th>
                   </tr>
                 </thead>
                 <tbody>
                   {data.picks.map(pick => (
                     <tr key={pick.pickId} data-testid={"pick-" + pick.pickId}>
                       <td>{pick.slateDate}</td>
                       <td><strong>{pick.playerName}</strong></td>
                       <td className="market-cell">{pick.market}</td>
                       <td>{pick.pickDirection}</td>
                       <td>{pick.mechanismTags.join(', ') || 'NONE'}</td>
                       <td>{pick.source.accountHandle}</td>
                       <td>
                         {pick.isLikelyCopy ? (
                           <Badge tone="warn">{pick.duplicationFlag}</Badge>
                         ) : (
                           <Badge tone="good">{pick.duplicationFlag}</Badge>
                         )}
                       </td>
                       <td>
                         {pick.predictionCorrect === true ? (
                           <Badge tone="good">CORRECT</Badge>
                         ) : pick.predictionCorrect === false ? (
                           <Badge tone="bad">INCORRECT</Badge>
                         ) : (
                           <Badge tone="neutral">PENDING</Badge>
                         )}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
            ) : <QueryMessage kind="empty" />}
          </Panel>
        </>
      )}
    </div>
  );
}

`;

content = content.replace('function Router() {', newComponent + 'function Router() {');
fs.writeFileSync(path, content, 'utf8');
