# Tian — Assistant AI nhúng (built-in) & tầm nhìn Agent

Tài liệu này chỉ đề cập **phần AI Agent / chat được tích hợp sẵn** trong fork này, không trộn với mô hình sản phẩm của Microsoft VS Code hay GitHub Copilot.

## Gian chat và chatbot (extension `extensions/tian-ai`)

**Tian AI** là extension bundle kèm mã nguồn, hiển thị **khung Chat** trong sidebar (activity bar Tian AI), không phụ thuộc marketplace để được cài thêm trong mô hình đóng gói sản phẩm của bạn.

- **Sidebar webview Chat:** phiên làm việc hội thoại với mô hình, stream phản hồi và log.
- **Bối cảnh chỉnh sửa gồm:** tuỳ chọn đính kèm nội dung file/editor đang mở, gợi ý và lệnh nhanh từ context menu (ví dụ giải thích selection).
- **Nhiều provider LLM:** cấu hình qua `settings` (provider, model, URL, ngưỡng token…); lõi runtime nằm trong `packages/ai-agent-core`.
- **Công cụ (tools) trên VS Code API:** ví dụ tìm kiếm file/nội dung workspace thông qua runner gắn với luồng agent (thay cho chỉ chat “trần”).
- **Đường dùng khác:** có thể luồng chat qua Output channel cho debug hoặc tích hợp nội bộ.

Mục tiêu trải nghiệm: **agent-first trong editor** — hội thoại gắn với codebase và workspace, chứ không chỉ một cửa sổ prompt tách khỏi luồng làm việc.

## Tầm nhìn Tian IDE — chỉ trụ AI Agent built-in

Tian IDE (theo chiều Agent) không định thay Code OSS khởi điểm bằng shell editor tự chế nhỏ hoàn toàn. **Tầm nhìn** là:

1. **Nền là fork Visual Studio Code (Code OSS)**  
   Giữ multiprocess workbench, Extension Host, và hệ sinh thái mở (theo licence / điều khoản của chính bạn và upstream). Chi phí không đốt vào việc tái ghép Monaco + SPA thành một IDE “pseudo-VS Code” riêng khi parity là mục tiêu dài.

2. **Định vị riêng ở bề mặt agent và AI** — gần với tinh thần mô hình được **[Cursor](https://cursor.com/)** miêu tả công khai: fork OSS để **định hình UX** và **gom agent vào lõi luồng làm việc** — chat, chỉnh sửa có hướng dẫn, và (sau này) chỉnh workbench/participant một cách thống nhất với sản phẩm của bạn, thay vì chỉ bọc một lớp extension mỏng nếu mục tiêu là parity trải nghiệm tương đương.

3. **Lõi agent tách khỏi shell UI (`packages/ai-agent-core`)**  
   Chuẩn hoá luồng chat, providers, và contract tool/event để tái dùng: trên Extension Host (như hiện tại) hoặc (sau) lớp tùy biến sâu hơn trong workbench, mà không sao chép logic agent rải rác.

4. **Hướng phát triển**  
   Củng cố agent + tool + context workspace trước; sau đó cân nhắc gắn nhiều hơn vào chat participant / session model của OSS nếu phù hợp roadmap và licence. Phân chia rõ: **upstream VS Code**, **telemetry/branding của Microsoft/Cursor không áp vào Tian** trừ khi cố ý tái licencing.

## Cấu trúc trong repo fork này

| Đường dẫn | Vai trò |
|-----------|---------|
| `extensions/tian-ai` | UI chat sidebar, đăng ký lệnh, webview — bundle `esbuild` vào `dist/`. |
| `packages/ai-agent-core` | Runtime agent: messaging, providers, vòng agent–tool — được extension import qua đường tương đối. |

Chi tiết bước build cụ thể của fork: xem **`TIAN-MIGRATION.txt`** và tài liệu contribute chính của Code OSS (**`CONTRIBUTING.md`**).
