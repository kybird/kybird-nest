import { config } from "@/lib/config";
import { LoginForm } from "./login-form";

/**
 * 초대 코드 요구 여부는 서버 설정이라 클라이언트가 직접 읽을 수 없다.
 * 서버 컴포넌트에서 읽어 넘긴다 — 코드 값이 아니라 "필요한지"만 넘어간다.
 */
export default function LoginPage() {
  return <LoginForm inviteRequired={config.inviteRequired} />;
}
