"""把 dashboard 两个接口的返回打成人能读的表格，供本地/远端验证时用。

用法:
  curl -s http://host:3500/api/users              | python3 scripts/show.py users
  curl -s http://host:3500/api/repos/<n>/aggregate | python3 scripts/show.py aggregate
"""
import json
import sys

mode = sys.argv[1]
d = json.load(sys.stdin)

if mode == "users":
    for u in d["users"]:
        print("  userName=%-22s displayName=%-10r status=%-8s updatedAt=%s"
              % (u["userName"], u["displayName"], u["status"], u["updatedAt"]))
    print("  summary:", d["summary"])

elif mode == "aggregate":
    t = d["totals"]
    print("  totals : commit_count=%s human_additions=%s ai_additions=%s"
          % (t["commit_count"], t["human_additions"], t["ai_additions"]))
    n = 0
    for k, v in d["by_user"].items():
        print("  by_user: %-24s display_name=%-10r commit_count=%s human_additions=%s"
              % (k, v["display_name"], v["commit_count"], v["human_additions"]))
        n += int(v["commit_count"])
    same = n == int(t["commit_count"])
    print("  by_user 合计 commit_count=%s  与 totals 一致? %s" % (n, "是" if same else "★否（一对多放大）"))
    sys.exit(0 if same else 1)

elif mode == "commits":
    for c in d:
        print("  sha=%-8s user_name=%-10s user_email=%-24s display_name=%r"
              % (c["commit_sha"], c["user_name"], c["user_email"], c.get("display_name")))
    print("  共 %d 行" % len(d))
