# 손상·빈 이미지 첨부가 raw backend 오류를 노출함

## 상태

- 상태: 미해결
- 발견일: 2026-07-22
- 우선순위: P2

## 증상

프로젝트리스 composer에서 확장자와 MIME type이 PNG인 손상 파일이나 0-byte 파일을 선택하면
사용자용 오류로 변환하지 않고 image artifact backend의 영문 exception 문구와 byte 구현값을
그대로 role=alert에 표시한다.

```text
손상 PNG: PNG signature is invalid
0-byte PNG: Image must contain 1..10485760 bytes
```

TXT, SVG, PDF에는 `PNG, JPEG, WebP, GIF 이미지만 첨부할 수 있습니다.`라는 한국어 형식 안내가
정상 표시되므로 같은 attachment validation surface 안에서도 오류 UX가 일관되지 않다.

## 재현

검수 draft: `5b58f4ae-b841-4393-bba3-c516de95d91f`

1. 프로젝트리스 `새 대화`에서 손상된 작은 PNG를 선택한다.
2. alert, preview, send enabled 상태를 확인한다.
3. 0-byte PNG로 반복한다.
4. TXT/SVG/PDF와 68-byte 유효 PNG를 대조한다.

실측 결과:

```text
TXT/SVG/PDF: 한국어 형식 alert, preview 0, send disabled
손상/0-byte PNG: raw English alert, preview 0, send disabled
유효 PNG: 첨부 이미지 region, filename alt/remove button, send enabled
remove 후: preview 0, send disabled
```

메시지는 전송하지 않아 canonical session이 생성되지 않았고, 8개 fixture를 만든 정확한 temp
directory는 검수 후 삭제해 부재를 확인했다. 10MiB 경계 fixture는 업로드하지 않았다.

## 원인

- client MIME allowlist 오류는 `ConversationWorkspace`에서 한국어 문구로 처리한다.
- upload API의 `invalid_image`·`invalid_image_size` 오류는 `errorMessage(cause)`를 통해 backend
  message를 그대로 composer alert에 노출한다.
- backend `image-artifacts.ts` message에 signature와 `MAX_IMAGE_ARTIFACT_BYTES` 숫자가 직접
  포함돼 있다.

## 영향

- 한국어 UI에서 이해하기 어려운 내부 구현 문구가 노출된다.
- `10485760` bytes가 사용자가 이해할 수 있는 10 MiB 제한으로 설명되지 않는다.
- backend wording 변경이 곧바로 사용자 UX와 접근성 alert 계약을 깨뜨린다.

## 완료 조건

- image artifact error code를 안정된 한국어 사용자 메시지로 매핑한다.
- 크기 제한은 10 MiB처럼 이해 가능한 단위와 해결 방법을 안내한다.
- raw parser/backend exception은 로그에만 남기고 UI에는 노출하지 않는다.
- unsupported MIME, zero-byte, corrupted signature, over-limit 이미지 E2E가 일관된 alert를 검증한다.

