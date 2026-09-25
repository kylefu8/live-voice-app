# Getting started

[简体中文](GETTING_STARTED.md) | **English**

Live Voice is a client for the **GPT-Live-1 real-time voice model**. Its optional backend LLM is a separate reasoning service. [All downloads](DOWNLOADS.en.md) · [Screenshots](SCREENSHOTS.en.md)

The recommended workflow is **deploy in Foundry → configure and test on Windows → scan the QR code on mobile**. Windows can also make its own calls, but it is not a relay for your phone.

![Recommended setup](images/recommended-setup-en.png)

## 1. Deploy both models in Microsoft Foundry

Open [Microsoft Foundry](https://ai.azure.com/) and prepare two model deployments in your project:

| Purpose | Recommended model | Live Voice connection |
| --- | --- | --- |
| Real-time listening, speaking, and interruption | `gpt-live-1` | Voice connection |
| Backend reasoning and web search | GPT-5.6 or newer | Backend connection |

This is the project's recommended combination, not a guarantee of availability in every region or subscription. Check your project's model catalog, access eligibility, and quota. Resolve deployment access before configuring the client. The backend must support the Responses interface used by the app; web search additionally depends on the model and service supporting the tool.

For each deployment, record its **endpoint, API key, actual model/deployment name, and authentication method**. If you chose a custom deployment name, enter that name rather than copying the catalog display name. See the [Microsoft Foundry documentation](https://learn.microsoft.com/en-us/azure/foundry/) for resource management and deployment.

## 2. Install Windows

Download the Windows ZIP from the [unified release page](https://github.com/kylefu8/live-voice-app/releases/latest), extract the entire folder, and run `Live Voice.exe`. Keep its accompanying files. No separate Node.js installation is required.

## 3. Configure and test the model connections

Open **Settings → Connections**. Enter each deployment's details under **Voice connection** and **Backend connection**, then select **Save connection** and **Test connection** for each.

- Enter an API base URL, not a Foundry management-page URL. Official Azure OpenAI resource roots are normalized to `/openai/v1`; custom gateways need their correct API base path.
- Enter the endpoint and API key separately. Match the service's authentication method; do not append a key to the URL.
- The two connections can use different resources, URLs, and keys. Saved keys only show masked prefixes/suffixes.
- Enable the backend in **Conversation settings**. Start with the defaults of **32768** maximum output tokens and web search enabled, then adjust reasoning effort for latency and answer quality.

Connection tests make real requests and may incur service usage. A successful test confirms that request and connection; it does not verify a full conversation or search experience.

## 4. Generate an encrypted QR code

Open **Settings → Connections → Generate configuration QR**. Select both saved connections, enter and confirm an import passphrase, and generate the QR code. Scan the screen directly or save the QR image.

The passphrase must contain at least four characters; a longer memorable passphrase is recommended. It is not embedded in the encrypted QR code. Sharing both the QR code and passphrase shares the connection credentials inside it.

## 5. Install mobile

- **Android:** download the arm64 APK from the [unified release page](https://github.com/kylefu8/live-voice-app/releases/latest) and install it on a compatible device. Existing installations support in-place upgrades.
- **iOS:** sign and install using a Mac and Xcode. No App Store or TestFlight download is currently available. A regular Apple ID's Personal Team can be used for testing on your own devices; see [iOS setup](../native/IOS.en.md) for signing requirements and limitations.

## 6. Scan, import, and test on the phone

Open **Settings → Connections → Import connections from QR** on the phone, allow camera access, and scan the code. Enter the same passphrase, review the endpoints, model names, and masked keys, select both connections, and choose **Test and save**.

Selected connections are saved only after all selected tests pass. Phone and PC networks may differ; a successful PC test does not guarantee phone connectivity.

QR import transfers connections only. It does not synchronize preferences, the backend enable switch, history, or recordings. After importing, enable **Enable backend** under **Settings → Conversation settings → Backend reasoning**, and review search, reasoning effort, and output length there.

## 7. Start a conversation on the phone

Return home, select **Start conversation**, allow microphone access, and speak naturally. You can interrupt or open conversation settings to change supported live preferences.

The phone connects directly to model services, so Windows can close. Each device keeps its own history and recordings. Model usage is billed by your Azure subscription or configured provider, separately from any Live Voice commercial software license.

## Troubleshooting

| Situation | What to check |
| --- | --- |
| The model is missing in Foundry | Check subscription, region, eligibility, and quota. A similarly named model is not automatically a GPT-Live-1 protocol replacement. |
| The test reports an unknown endpoint | Check the API base path and actual deployment name. |
| The QR passphrase is rejected | Use the passphrase for that specific QR code. A new passphrase cannot decrypt an older code. |
| Import succeeds but the backend is unused | Enable it separately on the phone. Actual backend delegation also depends on the conversation turn. |
| PC tests pass but phone tests fail | Check the phone's network access and the service's network restrictions. |
