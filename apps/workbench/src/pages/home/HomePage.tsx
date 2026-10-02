import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LearnerProfile } from "@study-studio/shared";
import { api } from "@/api";
import { fmtMinutes, greetingText } from "@/lib/format";
import { Modal } from "@/components/ui/Modal";
import { ProfileEditor } from "@/pages/settings/ProfileEditor";
import styles from "./HomePage.module.css";

export function HomePage() {
  const queryClient = useQueryClient();
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.getHomeSummary() });
  const [profileOpen, setProfileOpen] = useState(false);

  const saveProfile = useMutation({
    mutationFn: (profile: LearnerProfile) => api.putLearnerProfile(profile),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["learner-profile"] });
      setProfileOpen(false);
    }
  });

  if (home.isLoading || !home.data) return <div className="empty">加载中…</div>;
  const data = home.data;
  const hasProfile = Boolean(data.profile.role || data.profile.directions.length);

  return (
    <div className={`chat-home ${styles.home}`}>
      <div className="chat-hero">
        <div className="brand-logo" style={{ width: 44, height: 44, fontSize: 20, borderRadius: 12 }}>
          S
        </div>
        <h1>
          {greetingText(data.greetingPeriod)}，今天已经学习了 {fmtMinutes(data.today.minutes)}
        </h1>
        <div className="muted">基于你的学习记录与知识库回顾进度、薄弱点与待整理内容</div>
        <button type="button" className="profile-btn" style={{ marginTop: 8 }} onClick={() => setProfileOpen(true)} aria-label="学习者档案">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
          {hasProfile ? <i className="profile-dot" /> : null}
        </button>
      </div>

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

      <Modal open={profileOpen} onOpenChange={setProfileOpen} title="学习者档案" className="profile-modal">
        <ProfileEditor
          initial={data.profile}
          onCancel={() => setProfileOpen(false)}
          onSave={(profile) => saveProfile.mutate(profile)}
          saving={saveProfile.isPending}
        />
      </Modal>
    </div>
  );
}
