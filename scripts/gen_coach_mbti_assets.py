#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""教练MBTI 素材预处理（一次性，2026-11-13）。

输入（用户交付的 H5 定稿包，唯一真源）：
  E:/Administrator/Downloads/coach-mbti/questions.json
  E:/Administrator/Downloads/coach-mbti/coaches.json
  E:/Administrator/Downloads/coach-mbti/assets/coaches/*.png   (19 张)
  E:/Administrator/Downloads/coach-mbti/assets/covers/cover-c-back.png

输出：
  F:/OAO项目/产出/coach-mbti-assets/*.png      压缩图（长边 800px，供 upload_coach_mbti_assets.js 上云）
  eafc-miniapp/pkg-coach-mbti/data/questions.js    原样数据，包成 CommonJS 模块
  eafc-miniapp/pkg-coach-mbti/data/coaches.js      avatar 改写为 cloud:// fileID（零云函数，<image> 原生直连）
  （用 .js 而非 .json：与工程 data/*.js 惯例一致，避免分包静态 JSON 的 require 差异）
  ⚠️ 封面/品牌常量不在此生成：主包不能 require 分包文件，故统一放主包 utils/coachMbti.js
     （COVER/BRAND/COACH_COUNT/QUESTION_COUNT），本脚本的 CLOUD_* 常量与它逐字对齐。

⚠️ 数据红线 142 豁免：本活动是独立静态营销内容（固定题目/结果卡文案 + 用户交付插画），
   不含任何球员实时数据，与云库/云存储球员数据管线完全隔离。图片上云后不占分包体积。
⚠️ cloud:// 前缀与 eafc-miniapp/utils/format.js 的 CLOUD_ENV / CLOUD_BUCKET 逐字一致，
   采用确定性命名（同球员图），端上无需查表。
"""
import json
import os
import shutil
import sys
from PIL import Image

SRC = r"E:/Administrator/Downloads/coach-mbti"
ROOT = r"F:/OAO项目"
OUT_IMG = os.path.join(ROOT, "产出", "coach-mbti-assets")
OUT_DATA = os.path.join(ROOT, "eafc-miniapp", "pkg-coach-mbti", "data")

CLOUD_ENV = "cloud1-d5gq6q3np8708aeef"
CLOUD_BUCKET = "636c-cloud1-d5gq6q3np8708aeef-1475854307"
CLOUD_DIR = "fc27/coach_mbti"
LONG_EDGE = 800

# 源文件 basename -> 云端文件名（确定性，端上 coaches.json 按此拼）
COVER_SRC = "cover-c-back.png"
COVER_DST = "cover.png"


def compress(src_path, dst_path):
    im = Image.open(src_path).convert("RGB")
    w, h = im.size
    scale = LONG_EDGE / max(w, h)
    if scale < 1:
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    # 港漫平涂色块 → 256 色调色板量化，视觉损失极小、体积大幅下降；PNG 与 <image>/canvas 均兼容
    q = im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q.save(dst_path, "PNG", optimize=True)
    return os.path.getsize(dst_path)


def main():
    for d in (OUT_IMG, OUT_DATA):
        os.makedirs(d, exist_ok=True)

    # ① 读源数据并校验
    with open(os.path.join(SRC, "questions.json"), encoding="utf-8") as f:
        questions = json.load(f)
    with open(os.path.join(SRC, "coaches.json"), encoding="utf-8") as f:
        coaches = json.load(f)
    qlist, clist = questions["questions"], coaches["coaches"]
    assert len(qlist) == 14, "题目应为 14"
    assert len(clist) == 19, "结果卡应为 19"

    pool = {c["coach"] for c in clist}
    for c in clist:
        for s in c.get("similar", []):
            assert s["coach"] in pool, "similar 卡池外人物 id=%s: %s" % (c["id"], s["coach"])
    print("[check] 14 题 / 19 卡 / similar 全部卡池内 ✓")

    # ② 压缩 19 张教练图 + 封面，并改写 avatar 为 cloud:// fileID
    total = 0
    for c in clist:
        cid = c["id"]
        matches = [f for f in os.listdir(os.path.join(SRC, "assets", "coaches"))
                   if f.startswith("coach-%02d-" % cid) and f.lower().endswith(".png")]
        assert len(matches) == 1, "id=%s 素材缺失或重复: %s" % (cid, matches)
        name = matches[0]
        dst = os.path.join(OUT_IMG, name)
        size = compress(os.path.join(SRC, "assets", "coaches", name), dst)
        total += size
        c["avatar"] = "cloud://%s.%s/%s/%s" % (CLOUD_ENV, CLOUD_BUCKET, CLOUD_DIR, name)
        print("  %-32s %7.1f KB" % (name, size / 1024))

    cover_size = compress(os.path.join(SRC, "assets", "covers", COVER_SRC),
                          os.path.join(OUT_IMG, COVER_DST))
    total += cover_size
    print("  %-32s %7.1f KB" % (COVER_DST, cover_size / 1024))
    print("[img] 20 张合计 %.2f MB（上云，不占分包）" % (total / 1048576))

    # ③ 写端上数据（CommonJS 模块，与工程 data/*.js 惯例一致）
    def write_module(filename, varname, obj, comment):
        with open(os.path.join(OUT_DATA, filename), "w", encoding="utf-8") as f:
            f.write("// %s\n// ⚠️ 由 fetch-fc27/scripts/gen_coach_mbti_assets.py 生成，勿手改。\n" % comment)
            f.write("module.exports = ")
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.write(";\n")

    write_module("questions.js", "questions", questions, "教练MBTI 14 题（v4 定稿，源 questions.json）")
    write_module("coaches.js", "coaches", coaches, "教练MBTI 19 张结果卡（avatar 已改写为 cloud:// fileID）")
    print("[data] questions.js / coaches.js → " + OUT_DATA)
    print("✅ 完成。下一步：node scripts/upload_coach_mbti_assets.js")


if __name__ == "__main__":
    main()
