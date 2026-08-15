# Mind Agency 评测 Harness(eval/)

把 Mind Agency 的多智能体机制放到**等预算配对**的严格协议下评测。
方法论对齐 2026 年两篇关键工作:

- *Single-Agent LLMs Outperform MAS Under Equal Thinking Token Budgets*(arXiv:2604.02460)— equal-token 纪律、错误分桶
- *Towards a Science of Scaling Agent Systems*(arXiv:2512.08296)— 协作增益 Γ 的测量思想

## 三种对比配置(同一批题、同一个模型、同一总预算)

| 配置 | 结构 | 预算拆分 |
|------|------|---------|
| `sas` | 单 agent,1 次调用 | 100% |
| `debate` | 提出 → 批判 → 综合(3 agent) | 40% / 30% / 30% |
| `group` | 研究员 → 事实核查 → 综合(镜像 `Groups/default` 的 alice/bob/charlie 团队模式) | 40% / 30% / 30% |

总输出预算相同(默认 1000 tokens/题),temperature=0,因此
**Γ = acc(配置) / acc(sas)** 就是同预算下的协作增益:Γ>1 才是真协作价值。

## 快速开始

```bash
# 0. 准备数据(原始 42MB dev 集 → 4-hop 样本)
node eval/scripts/prepare-musique.mjs 30

# 1. 配置 key(评测沙箱,gitignored)
#    eval/.data/.mind/settings.json:
#    {"apiKey":"sk-...","baseUrl":"https://api.deepseek.com/anthropic","model":"deepseek-v4-flash"}
#    或直接设置环境变量 DEEPSEEK_API_KEY

# 2. 离线冒烟(mock 应答,验证全链路)
npx tsx eval/run.ts --config all --limit 5 --mock

# 3. 真实运行
npx tsx eval/run.ts --config all --limit 30 --budget 1000

# 4. 换模型 / 换预算 / 只跑单配置
EVAL_MODEL=deepseek-v4-pro npx tsx eval/run.ts --config sas --limit 10
npx tsx eval/run.ts --config debate,group --budget 2000
```

输出在 `eval/results/<时间戳>/`:`report.md`(汇总+Γ+错误交叉桶+逐题明细)、`results.jsonl`(每题每步 token/成本/延迟)、`summary.json`。

## 设计决策

1. **独立 provider 调用**:镜像 `src/lib/relay.ts` 的协议,但不经过 RAG/记忆/计费/限流。
   受控对比要求三种配置的唯一差异是"组织结构",RAG 注入会引入混淆变量。
   (Phase 2 再做"完整系统"对比:同一批题走 chatOnce + relay,含 RAG/技能注入。)
2. **短答案判分**:规范化 + 包含匹配(含答案别名)。MuSiQue 答案都是短实体名。
   LLM-judge 兜底是 Phase 2(judge 本身有偏见,见 Liang et al. 2023)。
3. **公平性**:三种配置输入信息相同(题目本身);预算只约束输出 tokens,
   输入 tokens(debate 里互相引用)如实记录、在报告里可见,不偷偷计入预算作弊。

## 安全注意

- `eval/.data/`、`eval/results/`、原始 42MB 下载文件均 gitignore,**不提交任何 key 或运行时产物**。
- key 只应写入 `eval/.data/.mind/settings.json` 或用环境变量传入。
- 若本机多人共用,跑完后建议轮换 DeepSeek key。

## 数据来源与许可

- 数据集:MuSiQue(StonyBrookNLP,CC BY-SA 4.0)。
  原始 dev 集(42MB)从官方 Google Drive 链接下载;
  本仓库只提交过滤后的 4-hop 样本 JSON(≈几十 KB),署名见 dataset meta。

## Phase 2 路线

- [ ] 完整系统对比(chatOnce + relay,含 RAG/技能/群组知识注入)
- [ ] LLM-judge 兜底判分 + judge bias 消融
- [ ] 群组知识注入变体(信息分布公平 vs 不公平时 Γ 的变化)
- [ ] 受控错误注入配对实验(Misinformation 风格,arXiv:2608.03421)
- [ ] 更多基准:GPQA-Diamond(需 HF token)、HumanEval-Plus(走 workflow executor)
- [ ] 多轮重跑方差报告(种子、置信区间)
