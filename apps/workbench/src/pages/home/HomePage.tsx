import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LearnerProfile } from "@study-studio/shared";
import { api } from "@/api";
import { fmtMinutes, greetingText } from "@/lib/format";
import { Modal } from "@/components/ui/Modal";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { ChatStatusBar } from "@/components/chat/ChatStatusBar";
import { chatExamples } from "@/components/chat/chat-context";
import { ExampleQuestions } from "@/components/chat/ExampleQuestions";
import { useChatSession } from "@/components/chat/useChatSession";
import { ProfileEditor } from "@/pages/settings/ProfileEditor";
import styles from "./HomePage.module.css";

const PLACEHOLDER = "问问你学过的内容，或告诉我「我最近在学 AI 相关知识」";
const HOME_EXAMPLES = chatExamples({ page: "home" });

export function HomePage() {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.getHomeSummary() });
  const session = useChatSession();
  const [profileOpen, setProfileOpen] = useState(false);

  const saveProfile = useMutation({
    mutationFn: (profile: LearnerProfile) => api.putLearnerProfile(profile),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["learner-profile"] });
      setProfileOpen(false);
    }
  });

  if (home.isLoading || !home.data || !session.historyLoaded) return <div className="empty">加载中…</div>;
  const data = home.data;
  const hasProfile = Boolean(data.profile.role || data.profile.directions.length);
  const disabled = !session.configured;

  const profileButton = (
    <button type="button" className="profile-btn" onClick={() => setProfileOpen(true)} aria-label="学习者档案" title="学习者档案">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
      {hasProfile ? <i className="profile-dot" /> : null}
    </button>
  );

  const composer = (
    <ChatComposer
      variant="home"
      busy={session.busy}
      disabled={disabled}
      placeholder={disabled ? "未配置对话模型，配置后即可提问" : PLACEHOLDER}
      onSend={session.send}
      onStop={session.stop}
      trailing={profileButton}
      autoFocus
    />
  );

  const profileModal = (
    <Modal open={profileOpen} onOpenChange={setProfileOpen} title="学习者档案" className="profile-modal">
      <ProfileEditor
        initial={data.profile}
        onCancel={() => setProfileOpen(false)}
        onSave={(profile) => saveProfile.mutate(profile)}
        saving={saveProfile.isPending}
      />
    </Modal>
  );

  if (session.messages.length > 0) {
    return (
      <div className="chat-page">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="muted small">基于学习记录与知识库回答 · 对话不计入收集箱</span>
          <div className="grow" />
          <button type="button" className="btn sm" onClick={session.clear}>
            清空对话
          </button>
        </div>
        <ChatMessageList className="chat-list" messages={session.messages} status={session.status} currentPage="home" footer={<ChatStatusBar {...session} />} />
        <div className="chat-dock">{composer}</div>
        {profileModal}
      </div>
    );
  }

  return (
    <div className={`chat-home ${styles.home}`}>
      <div className="chat-hero">
        <div className="brand-logo" style={{ width: 44, height: 44, fontSize: 20, borderRadius: 12 }}>
          S
        </div>
        <h1>
          {greetingText(data.greetingPeriod)}，今天已经学习了 {fmtMinutes(data.today.minutes)}
        </h1>
        <div className="muted">基于你的学习记录与知识库回答：学过什么、掌握得怎样、还缺什么</div>
      </div>

      {composer}
      <ChatStatusBar {...session} />
      <ExampleQuestions questions={HOME_EXAMPLES} variant="chips" disabled={disabled} onAsk={session.send} />

      <div className={`home-stats ${styles.cards}`}>
        <Link to="/progress" className={styles.card}>
          <span className="muted">今日学习</span>
          <b>
            {data.today.pages} 篇网页 · {data.today.qa} 次问答
          </b>
        </Link>
        <Link to="/wiki" className={styles.card}>
          <span className="muted">知识库</span>
          <b>
            {data.knowledgeEntryCount} 个知识点 · 待整理 {data.pending.pendingOrganize}
          </b>
        </Link>
        <Link to="/wiki" className={styles.card}>
          <span className="muted">薄弱知识点</span>
          <b style={{ color: "var(--orange)" }}>{data.pending.weakEntries} 个</b>
        </Link>
      </div>

      {profileModal}
    </div>
  );
}
