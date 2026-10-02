import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { Modal } from "@/components/ui/Modal";
import { useUiStore } from "@/stores/ui";
import { setGroup, setRow } from "./SettingsPage";

export function SettingsData() {
  const queryClient = useQueryClient();
  const pushToast = useUiStore((state) => state.pushToast);
  const info = useQuery({ queryKey: ["data-info"], queryFn: () => api.getDataInfo() });
  const [wipeOpen, setWipeOpen] = useState(false);
  const [confirm, setConfirm] = useState("");

  const exportData = useMutation({
    mutationFn: () => api.exportData(),
    onSuccess: (result) => pushToast({ message: `已导出 ${result.filename}` })
  });
  const importData = useMutation({
    mutationFn: () => api.importData(),
    onSuccess: () => pushToast({ message: "导入完成" })
  });
  const reindex = useMutation({
    mutationFn: () => api.reindex(),
    onSuccess: () => pushToast({ message: "已开始重建索引" })
  });
  const reveal = useMutation({
    mutationFn: () => api.revealDataDir(),
    onSuccess: () => pushToast({ message: "已请求打开数据目录" })
  });
  const resetToken = useMutation({
    mutationFn: () => api.resetPairing(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["data-info"] });
      pushToast({ message: "配对令牌已重置" });
    }
  });
  const wipe = useMutation({
    mutationFn: () => api.wipeData({ confirm: "清空" }),
    onSuccess: async () => {
      setWipeOpen(false);
      setConfirm("");
      await queryClient.invalidateQueries();
      pushToast({ message: "已清空全部数据" });
    }
  });

  if (!info.data) return <div className="empty">加载中…</div>;
  const sizeMb = (info.data.sizeBytes / (1024 * 1024)).toFixed(1);

  return (
    <>
      {setGroup(
        "本地数据",
        <>
          {setRow(
            "本地服务",
            `${info.data.address} · 运行 ${Math.round(info.data.uptimeSeconds / 60)} 分钟 · SQLite ${info.data.sqliteVersion}`,
            <span className="tag green">正常</span>
          )}
          {setRow(
            "数据目录",
            `${info.data.dataDir} · ${sizeMb} MB · ${info.data.itemCount} 条内容`,
            <button type="button" className="btn sm" onClick={() => reveal.mutate()}>
              打开目录
            </button>
          )}
          {setRow(
            "导出备份",
            "打包为 zip，不含 API Key",
            <button type="button" className="btn sm" onClick={() => exportData.mutate()}>
              导出
            </button>
          )}
          {setRow(
            "导入备份",
            "校验后替换本地库",
            <button type="button" className="btn sm" onClick={() => importData.mutate()}>
              导入
            </button>
          )}
          {setRow(
            "重建索引",
            "清空并重建 chunks / FTS / 向量",
            <button type="button" className="btn sm" onClick={() => reindex.mutate()}>
              重建
            </button>
          )}
        </>
      )}
      {setGroup("隐私", setRow("数据只保存在本机", "收集内容、笔记和知识库都存放在数据目录；只有整理时相关内容会发送给你配置的模型服务商"))}
      <section className="set-group danger-zone">
        <div className="set-group-head">
          <h3>危险操作</h3>
        </div>
        <div className="set-card">
          {setRow(
            "重置配对令牌",
            "旧令牌立即失效",
            <button type="button" className="btn sm danger" onClick={() => resetToken.mutate()}>
              重置
            </button>
          )}
          {setRow(
            "清空所有数据",
            "先自动备份，再删除全部业务数据",
            <button type="button" className="btn sm danger" onClick={() => setWipeOpen(true)}>
              清空
            </button>
          )}
        </div>
      </section>

      <Modal open={wipeOpen} onOpenChange={setWipeOpen} title="清空所有数据？">
        <div className="stack" style={{ gap: 10 }}>
          <div>此操作不可手动撤销。请输入「清空」确认。</div>
          <input className="input" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="清空" />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setWipeOpen(false)}>
              取消
            </button>
            <button type="button" className="btn primary danger-fill" disabled={confirm !== "清空"} onClick={() => wipe.mutate()}>
              确认清空
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
