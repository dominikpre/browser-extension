import { init, track } from '@amplitude/analytics-browser';
import Browser from 'webextension-polyfill';
import { AllowList, RequestType, WarningType } from './lib/constants';
import {
  isTransactionMessage,
  isTypedSignatureMessage,
  Message,
  MessageResponse,
  TransactionMessage,
  TypedSignatureMessage,
  UntypedSignatureMessage,
} from './lib/types';
import { decodeApproval, decodeNftListing, decodePermit } from './lib/utils/decode';
import { randomId } from './lib/utils/misc';
import { getStorage, setStorage } from './lib/utils/storage';

// This is technically async, but it's safe to assume that this will complete before any tracking occurs
if (process.env.AMPLITUDE_API_KEY) {
  const initialiseAmplitude = async () => {
    const storedId = await getStorage<string>('sync', 'user:id');
    const userId = storedId ?? randomId();
    if (!storedId) await setStorage('sync', 'user:id', userId);
    init(process.env.AMPLITUDE_API_KEY!, userId);
  };

  initialiseAmplitude();
}

// Note that these messages will be periodically cleared due to the background service shutting down
// after 5 minutes of inactivity (see Manifest v3 docs).
const messagePorts: { [index: string]: Browser.Runtime.Port } = {};
const approvedMessages: string[] = [];

const setupRemoteConnection = async (remotePort: Browser.Runtime.Port) => {
  remotePort.onMessage.addListener((message: Message) => {
    processMessage(message, remotePort);
  });
};

Browser.runtime.onConnect.addListener(setupRemoteConnection);

Browser.runtime.onMessage.addListener((response: MessageResponse) => {
  const responsePort = messagePorts[response.requestId];

  track('Responded to request', { requestId: response.requestId, response: response.data });

  if (response.data) {
    approvedMessages.push(response.requestId);
  }

  if (responsePort) {
    responsePort.postMessage(response);
    delete messagePorts[response.requestId];
    return;
  }
});

const processMessage = async (message: Message, remotePort: Browser.Runtime.Port) => {
  const popupCreated = await createPopup(message);

  // For bypassed messages we have no response to return
  if (message.data.bypassed) return;

  // If no popup was created, we respond positively to indicate that the request should go through
  if (!popupCreated) {
    remotePort.postMessage({ requestId: message.requestId, data: true });
    return;
  }

  // Store the remote port so the response can be sent back there
  messagePorts[message.requestId] = remotePort;
};

const createPopup = (message: Message): Promise<boolean> => {
  if (isTransactionMessage(message)) {
    return createAllowancePopup(message);
  } else if (isTypedSignatureMessage(message)) {
    const mayBePermit = message.data.typedData.primaryType === 'Permit';
    return mayBePermit ? createAllowancePopup(message) : createNftListingPopup(message);
  } else {
    return createHashSignaturePopup(message);
  }
};

const createAllowancePopup = async (message: TransactionMessage | TypedSignatureMessage) => {
  const warnOnApproval = await getStorage('local', 'settings:warnOnApproval', true);
  if (!warnOnApproval) return false;

  const { requestId } = message;
  const { chainId, hostname, bypassed } = message.data;
  if (AllowList.ALLOWANCE.includes(hostname)) return false;
  if (approvedMessages.includes(message.requestId)) return false;

  const allowance =
    message.data.type === RequestType.TRANSACTION
      ? decodeApproval(message.data.transaction)
      : decodePermit(message.data.typedData);
  if (!allowance) return false;

  const queryString = new URLSearchParams({
    type: WarningType.ALLOWANCE,
    requestId,
    asset: allowance.asset,
    spender: allowance.spender,
    chainId: String(chainId),
    bypassed: String(bypassed),
    hostname,
  }).toString();

  createConfirmationPopup(queryString, 2, bypassed);
  track('Allowance requested', { requestId, chainId, hostname, allowance });

  // Return true after creating the popup
  return true;
};

const createNftListingPopup = async (message: TypedSignatureMessage) => {
  const warnOnListing = await getStorage('local', 'settings:warnOnListing', true);
  if (!warnOnListing) return false;

  const { requestId } = message;
  const { typedData, chainId, hostname, bypassed } = message.data;
  if (AllowList.NFT_LISTING.includes(hostname)) return false;
  if (approvedMessages.includes(message.requestId)) return false;

  const { platform, listing } = decodeNftListing(typedData);
  if (!listing) return false;

  const queryString = new URLSearchParams({
    type: WarningType.LISTING,
    requestId,
    listing: JSON.stringify(listing),
    platform,
    chainId: String(chainId),
    bypassed: String(bypassed),
    hostname,
  }).toString();

  createConfirmationPopup(queryString, listing.offer.length + listing.consideration.length, bypassed);
  track('NFT listing requested', { requestId, chainId, hostname, platform, listing });

  // Return true after creating the popup
  return true;
};

const createHashSignaturePopup = async (message: UntypedSignatureMessage) => {
  const warnOnHashSignatures = await getStorage('local', 'settings:warnOnHashSignatures', true);
  if (!warnOnHashSignatures) return false;

  const { requestId } = message;
  const { message: signMessage, hostname, bypassed } = message.data;
  if (AllowList.HASH_SIGNATURE.includes(hostname)) return false;
  if (approvedMessages.includes(message.requestId)) return false;

  // If we're not signing a hash, we don't need to popup
  if (String(signMessage).replace(/0x/, '').length !== 64) return false;

  const queryString = new URLSearchParams({
    type: WarningType.HASH,
    requestId,
    bypassed: String(bypassed),
    hostname,
  }).toString();

  createConfirmationPopup(queryString, 0, bypassed);
  track('Hash signature requested', { requestId, hostname });

  // Return true after creating the popup
  return true;
};

export const createConfirmationPopup = async (queryString: string, contentLines: number, bypassed?: boolean) => {
  // Add a slight delay to prevent weird window positioning
  const delayPromise = new Promise((resolve) => setTimeout(resolve, 150));
  const [currentWindow] = await Promise.all([Browser.windows.getCurrent(), delayPromise]);
  const positions = getPopupPositions(currentWindow, contentLines, bypassed);

  const popupWindow = await Browser.windows.create({
    url: `confirm.html?${queryString}`,
    type: 'popup',
    ...positions,
  });

  // Specifying window position does not work on Firefox, so we have to reposition after creation (6 y/o bug -_-).
  // Has no effect on Chrome, because the window position is already correct.
  await Browser.windows.update(popupWindow.id!, positions);
};

const getPopupPositions = (window: Browser.Windows.Window, contentLines: number, bypassed?: boolean) => {
  const width = 480;
  const height = 320 + contentLines * 24 + (bypassed ? 24 : 0);

  const left = window.left! + Math.round((window.width! - width) * 0.5);
  const top = window.top! + Math.round((window.height! - height) * 0.2);

  return { width, height, left, top };
};
