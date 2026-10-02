import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LearnerProfile } from "@study-studio/shared";
import { api } from "@/api";
import { ProfileEditor } from "./ProfileEditor";
import { setGroup } from "./SettingsPage";

export function SettingsProfile() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ["learner-profile"], queryFn: () => api.getLearnerProfile() });
  const save = useMutation({
    mutationFn: (next: LearnerProfile) => api.putLearnerProfile(next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["learner-profile"] });
      await queryClient.invalidateQueries({ queryKey: ["home"] });
    }
  });

  if (!profile.data) return <div className="empty">加载中…</div>;

  return setGroup(
    "学习者档案",
    <ProfileEditor initial={profile.data.profile} saving={save.isPending} onCancel={() => undefined} onSave={(next) => save.mutate(next)} />
  );
}
