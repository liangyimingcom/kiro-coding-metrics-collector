/**
 * 硬编码的 Dashboard API 配置
 *
 * 指向部署在客户 VPC 私有子网 (kiro-ai-us-east-1, 10.162.255.0/26) 内的
 * Ingest API（EC2 私有 IP，监听 80 端口）。Kiro IDE 需在可经
 * VPN / VPC peering / Direct Connect 到达该 VPC 的企业网内运行。
 *
 * 如需改为内网 ALB / 私有 DNS，仅需替换此处的 STATS_BASE_URL 并重新打包。
 */
export const STATS_BASE_URL = "http://10.162.255.8";
export const STATS_API_PATH = "/api/v1/stats";
export const USER_SYNC_API_PATH = "/api/v1/userSync";
export const STATS_URL = STATS_BASE_URL + STATS_API_PATH;
export const USER_SYNC_URL = STATS_BASE_URL + USER_SYNC_API_PATH;
