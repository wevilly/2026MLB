import { useState, useEffect, useRef, useMemo } from 'react';
import { Sparkles, Send, Check, X, BookOpen, Clock, Play, FileText, AlertTriangle, MessageSquare, ListTodo, FileCheck } from 'lucide-react';
import {
  useChatWithAnalystAi,
  useGetAnalystAiDrafts,
  useCreateAnalystAiDraft,
  useApproveAnalystAiDraft,
  useRejectAnalystAiDraft,
  useGetAnalystAiSourcingRegister,
  useDecideAnalystAiSourcingClaim,
  useGetAnalystAiResearchNotes,
  AiChatHistoryMessage,
  AiResearchDraft,
  AiSourcingClaim,
  AiResearchDraftList,
  AiSourcingRegister,
  AiChatHistoryMessageRole
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, Kicker, SectionHeading, Badge, StatusDot, LoadingPanel, QueryMessage, toneFor } from '../App';

function getSessionId() {
  let id = localStorage.getItem('ai-analyst-session');
  if (!id) {
    id = `session-${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('ai-analyst-session', id);
  }
  return id;
}

export default function AiAnalystPage() {
  const [activeTab, setActiveTab] = useState<'workspace' | 'drafts' | 'sourcing' | 'notes'>('workspace');
  const sessionId = useMemo(() => getSessionId(), []);

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Phase 8B / LLM interface</Kicker>
          <h1>AI Analyst <span className="slash">//</span> workspace</h1>
          <p>Chat with the reasoning engine, review its source claims, and approve research drafts.</p>
        </div>
        <div className="ai-tabs">
          <button className={`ai-tab ${activeTab === 'workspace' ? 'ai-tab-active' : ''}`} onClick={() => setActiveTab('workspace')} data-testid="tab-workspace"><MessageSquare size={14} /> Workspace</button>
          <button className={`ai-tab ${activeTab === 'sourcing' ? 'ai-tab-active' : ''}`} onClick={() => setActiveTab('sourcing')} data-testid="tab-sourcing"><FileCheck size={14} /> Sourcing claims</button>
          <button className={`ai-tab ${activeTab === 'drafts' ? 'ai-tab-active' : ''}`} onClick={() => setActiveTab('drafts')} data-testid="tab-drafts"><ListTodo size={14} /> Draft queue</button>
        </div>
      </div>
      
      {activeTab === 'workspace' && <WorkspaceTab sessionId={sessionId} />}
      {activeTab === 'sourcing' && <SourcingTab sessionId={sessionId} />}
      {activeTab === 'drafts' && <DraftsTab sessionId={sessionId} />}
    </div>
  );
}

function WorkspaceTab({ sessionId }: { sessionId: string }) {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<AiChatHistoryMessage[]>([]);
  const chatMutation = useChatWithAnalystAi();
  const draftMutation = useCreateAnalystAiDraft();
  const queryClient = useQueryClient();

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || chatMutation.isPending) return;
    
    const userMsg = input.trim();
    setInput('');
    
    const newHistory = [...history, { role: 'user' as const, content: userMsg }];
    setHistory(newHistory);
    
    chatMutation.mutate({
      data: {
        sessionId,
        message: userMsg,
        history: history.slice(-8)
      }
    }, {
      onSuccess: (result) => {
        setHistory(prev => [...prev, { role: 'assistant' as const, content: result.response }]);
        queryClient.invalidateQueries({ queryKey: ['getAnalystAiSourcingRegister'] });
      },
      onError: () => {
        setHistory(prev => [...prev, { role: 'assistant' as const, content: "ERROR: Communication failed." }]);
      }
    });
  };

  const saveAsDraft = () => {
    if (!chatMutation.data) return;
    draftMutation.mutate({
      data: {
        sessionId,
        draftContent: chatMutation.data.response,
        sourceClaimIds: chatMutation.data.sourcingClaimIds
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['getAnalystAiDrafts'] });
      }
    });
  };

  return (
    <div className="ai-workspace">
      <Panel className="chat-panel">
        <SectionHeading eyebrow="Reasoning Engine" title="Analyst Assistant" detail="Context window includes current state." />
        <div className="chat-history">
          {history.length === 0 ? (
            <div className="chat-empty">
              <Sparkles size={24} />
              <p>The AI Analyst is ready. Ask about player match-ups, recent data anomalies, or request a research summary.</p>
            </div>
          ) : (
            history.map((msg, idx) => (
              <div key={idx} className={`chat-bubble chat-bubble-${msg.role}`} data-testid={`chat-message-${msg.role}-${idx}`}>
                <div className="chat-bubble-label">{msg.role === 'user' ? 'Operator' : 'AI Analyst'}</div>
                <div className="chat-bubble-content">{msg.content}</div>
              </div>
            ))
          )}
          {chatMutation.isPending && (
            <div className="chat-bubble chat-bubble-assistant chat-thinking">
              <StatusDot tone="good" pulse /> Thinking...
            </div>
          )}
        </div>
        <div className="chat-controls">
          {chatMutation.data?.canCreateDraft && (
            <button type="button" className="button button-quiet" onClick={saveAsDraft} disabled={draftMutation.isPending} data-testid="button-save-draft">
              <BookOpen size={14} /> {draftMutation.isPending ? 'Saving...' : 'Save last response as Draft'}
            </button>
          )}
        </div>
        <form className="chat-input-form" onSubmit={handleSend}>
          <input
            type="text"
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question or request analysis..."
            disabled={chatMutation.isPending}
            data-testid="input-chat-message"
          />
          <button type="submit" className="button button-dark" disabled={!input.trim() || chatMutation.isPending} data-testid="button-send-chat">
            <Send size={14} /> Send
          </button>
        </form>
      </Panel>
      <div className="workspace-side">
        <Panel>
          <SectionHeading eyebrow="Session info" title="Active Context" />
          <div className="metric-grid ai-metric-grid">
            <div className="metric">
              <span className="metric-label">Session ID</span>
              <strong>{sessionId.slice(0, 12)}...</strong>
            </div>
            <div className="metric">
              <span className="metric-label">Memory</span>
              <strong>{history.length} msgs</strong>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function DraftsTab({ sessionId }: { sessionId: string }) {
  const { data, isLoading, isError, refetch } = useGetAnalystAiDrafts({ sessionId });
  const approveMutation = useApproveAnalystAiDraft();
  const rejectMutation = useRejectAnalystAiDraft();
  const queryClient = useQueryClient();

  const handleApprove = (draftId: string) => {
    approveMutation.mutate({
      draftId,
      data: { reviewedBy: 'Operator' }
    }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['getAnalystAiDrafts'] })
    });
  };

  const handleReject = (draftId: string) => {
    rejectMutation.mutate({
      draftId,
      data: { reviewedBy: 'Operator', rejectionReason: 'Declined by operator review' }
    }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['getAnalystAiDrafts'] })
    });
  };

  if (isLoading) return <LoadingPanel rows={5} />;
  if (isError) return <QueryMessage kind="error" onRetry={() => refetch()} />;
  
  const draftList = data as AiResearchDraftList | undefined;
  
  return (
    <Panel className="drafts-panel">
      <SectionHeading eyebrow="Review Queue" title="Unapproved Drafts" detail={`${draftList?.total ?? 0} total drafts requiring review`} action={<button className="icon-button" onClick={() => refetch()}><Clock size={14} /></button>} />
      
      {!draftList?.drafts?.length ? (
        <QueryMessage kind="empty" />
      ) : (
        <div className="draft-list">
          {draftList.drafts.map((draft) => (
            <div key={draft.draftId} className="draft-card" data-testid={`draft-card-${draft.draftId}`}>
              <div className="draft-header">
                <div>
                  <strong>Draft {draft.draftId.slice(0,8)}</strong>
                  <Badge tone={draft.status === 'APPROVED' ? 'good' : draft.status === 'REJECTED' ? 'bad' : 'warn'}>{draft.status}</Badge>
                </div>
                <span>{new Date(draft.createdAt).toLocaleString()}</span>
              </div>
              <div className="draft-content">
                {draft.draftContent}
              </div>
              {draft.status === 'DRAFT' && (
                <div className="draft-actions">
                  <button className="button button-quiet" onClick={() => handleReject(draft.draftId)} data-testid={`button-reject-${draft.draftId}`} disabled={rejectMutation.isPending}>
                    <X size={14} /> Reject
                  </button>
                  <button className="button button-yellow" onClick={() => handleApprove(draft.draftId)} data-testid={`button-approve-${draft.draftId}`} disabled={approveMutation.isPending}>
                    <Check size={14} /> Approve
                  </button>
                </div>
              )}
              {draft.status !== 'DRAFT' && (
                <div className="draft-reviewer-note">
                  <StatusDot tone={draft.status === 'APPROVED' ? 'good' : 'bad'} /> Reviewed by {draft.reviewedBy}
                  {draft.rejectionReason && ` - ${draft.rejectionReason}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function SourcingTab({ sessionId }: { sessionId: string }) {
  const { data, isLoading, isError, refetch } = useGetAnalystAiSourcingRegister({ sessionId });
  const decideMutation = useDecideAnalystAiSourcingClaim();
  const queryClient = useQueryClient();

  const handleDecision = (claimId: string, accepted: boolean) => {
    decideMutation.mutate({
      claimId,
      data: {
        accepted,
        reviewedBy: 'Operator',
        rejectionReason: accepted ? undefined : 'Sourcing disputed by operator'
      }
    }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['getAnalystAiSourcingRegister'] })
    });
  };

  if (isLoading) return <LoadingPanel rows={5} />;
  if (isError) return <QueryMessage kind="error" onRetry={() => refetch()} />;
  
  const register = data as AiSourcingRegister | undefined;

  return (
    <Panel className="sourcing-panel">
      <SectionHeading eyebrow="Provenance" title="Sourcing Register" detail={`${register?.total ?? 0} citations registered`} action={<button className="icon-button" onClick={() => refetch()}><Clock size={14} /></button>} />
      
      {!register?.claims?.length ? (
        <QueryMessage kind="empty" />
      ) : (
        <div className="claim-list">
          {register.claims.map((claim) => (
            <div key={claim.claimId} className="claim-card" data-testid={`claim-card-${claim.claimId}`}>
              <div className="claim-header">
                <div>
                  <StatusDot tone={claim.accepted === true ? 'good' : claim.accepted === false ? 'bad' : 'warn'} />
                  <strong>{claim.sourceType}</strong>
                  <span>{claim.sourceUrlOrDescription}</span>
                </div>
                {claim.accepted === null ? (
                  <Badge tone="warn">PENDING</Badge>
                ) : (
                  <Badge tone={claim.accepted ? 'good' : 'bad'}>{claim.accepted ? 'ACCEPTED' : 'REJECTED'}</Badge>
                )}
              </div>
              <p className="claim-text">"{claim.claimText}"</p>
              
              {claim.accepted === null && (
                <div className="claim-actions">
                  <button className="button button-quiet" onClick={() => handleDecision(claim.claimId, false)} data-testid={`button-reject-claim-${claim.claimId}`}>
                    <X size={14} /> Reject citation
                  </button>
                  <button className="button button-dark" onClick={() => handleDecision(claim.claimId, true)} data-testid={`button-accept-claim-${claim.claimId}`}>
                    <Check size={14} /> Accept citation
                  </button>
                </div>
              )}
              {claim.accepted !== null && (
                <div className="claim-reviewer-note">
                  Reviewed by {claim.reviewedBy} {claim.rejectionReason && `- ${claim.rejectionReason}`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
