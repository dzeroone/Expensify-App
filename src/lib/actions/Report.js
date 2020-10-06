import moment from 'moment';
import _ from 'underscore';
import lodashGet from 'lodash.get';
import Ion from '../Ion';
import * as API from '../API';
import IONKEYS from '../../IONKEYS';
import CONFIG from '../../CONFIG';
import * as Pusher from '../Pusher/pusher';
import promiseAllSettled from '../promiseAllSettled';
import ExpensiMark from '../ExpensiMark';
import Notification from '../Notification';
import * as PersonalDetails from './PersonalDetails';
import {redirect} from './App';
import * as ActiveClientManager from '../ActiveClientManager';
import Visibility from '../Visibility';

let currentUserEmail;
let currentUserAccountID;
Ion.connect({
    key: IONKEYS.SESSION,
    callback: (val) => {
        // When signed out, val is undefined
        if (val) {
            currentUserEmail = val.email;
            currentUserAccountID = val.accountID;
        }
    }
});

let currentURL;
Ion.connect({
    key: IONKEYS.CURRENT_URL,
    callback: val => currentURL = val,
});

let myPersonalDetails;
Ion.connect({
    key: IONKEYS.MY_PERSONAL_DETAILS,
    callback: val => myPersonalDetails = val,
});

// Keeps track of the max sequence number for each report
const reportMaxSequenceNumbers = {};

// Keeps track of the last read for each report
const lastReadActionIDs = {};

// List of reportIDs that we define in .env
const configReportIDs = CONFIG.REPORT_IDS.split(',').map(Number);

/**
 * Checks the report to see if there are any unread action items
 *
 * @param {object} report
 * @returns {boolean}
 */
function getUnreadActionCount(report) {
    const usersLastReadActionID = lodashGet(report, [
        'reportNameValuePairs',
        `lastReadActionID_${currentUserAccountID}`,
    ]);

    // Save the lastReadActionID locally so we can access this later
    lastReadActionIDs[report.reportID] = usersLastReadActionID;

    if (report.reportActionList.length === 0) {
        return 0;
    }

    if (!usersLastReadActionID) {
        return report.reportActionList.length;
    }

    // Find the most recent sequence number from the report itself or the local store of max sequence numbers
    const maxSequenceNumber = Math.max(reportMaxSequenceNumbers[report.reportID] || 0, report.reportActionList.length);

    // There are unread items if the last one the user has read is less
    // than the highest sequence number we have.
    const unreadActionCount = maxSequenceNumber - usersLastReadActionID;
    return Math.max(0, unreadActionCount);
}

/**
 * Only store the minimal amount of data in Ion that needs to be stored
 * because space is limited
 *
 * @param {object} report
 * @param {number} report.reportID
 * @param {string} report.reportName
 * @param {object} report.reportNameValuePairs
 * @returns {object}
 */
function getSimplifiedReportObject(report) {
    const maxSequenceNumber = Math.max(reportMaxSequenceNumbers[report.reportID] || 0, report.reportActionList.length);
    const unreadActionCount = getUnreadActionCount(report);
    return {
        reportID: report.reportID,
        reportName: report.reportName,
        reportNameValuePairs: report.reportNameValuePairs,
        unreadActionCount,
        pinnedReport: configReportIDs.includes(report.reportID),
        maxSequenceNumber,
    };
}

/**
 * Returns a generated report title based on the participants
 *
 * @param {array} sharedReportList
 * @return {string}
 */
function getChatReportName(sharedReportList) {
    return _.chain(sharedReportList)
        .map(participant => participant.email)
        .filter(participant => participant !== currentUserEmail)
        .map(participant => PersonalDetails.getDisplayName(participant))
        .value()
        .join(', ');
}

/**
 * Fetches chat reports when provided a list of
 * chat report IDs
 *
 * @param {Array} chatList
 * @return {Promise} only used internally when fetchAll() is called
 */
function fetchChatReportsByIDs(chatList) {
    let fetchedReports;
    return API.get({
        returnValueList: 'reportStuff',
        reportIDList: chatList.join(','),
        shouldLoadOptionalKeys: true,
    })
        .then(({reports}) => {
            fetchedReports = reports;

            // Build array of all participant emails so we can
            // get the personal details.
            const emails = _.chain(reports)
                .pluck('sharedReportList')
                .reduce((participants, sharedList) => {
                    const emailArray = _.map(sharedList, participant => participant.email);
                    return [...participants, ...emailArray];
                }, [])
                .filter(email => email !== currentUserEmail)
                .unique()
                .value();

            // Fetch the person details if there are any
            if (emails && emails.length !== 0) {
                PersonalDetails.getForEmails(emails.join(','));
            }

            // Process the reports and store them in Ion
            _.each(fetchedReports, (report) => {
                const newReport = getSimplifiedReportObject(report);

                if (lodashGet(report, 'reportNameValuePairs.type') === 'chat') {
                    newReport.reportName = getChatReportName(report.sharedReportList);
                }

                // Merge the data into Ion
                Ion.merge(`${IONKEYS.COLLECTION.REPORT}${report.reportID}`, newReport);
            });

            return {reports: fetchedReports};
        });
}

/**
 * Updates a report in the store with a new report action
 *
 * @param {number} reportID
 * @param {object} reportAction
 */
function updateReportWithNewAction(reportID, reportAction) {
    const newMaxSequenceNumber = reportAction.sequenceNumber;

    // Always merge the reportID into Ion
    // If the report doesn't exist in Ion yet, then all the rest of the data will be filled out
    // by handleReportChanged
    Ion.merge(`${IONKEYS.COLLECTION.REPORT}${reportID}`, {
        reportID,
        unreadActionCount: newMaxSequenceNumber - (lastReadActionIDs[reportID] || 0),
        maxSequenceNumber: reportAction.sequenceNumber,
    });

    // Add the action into Ion
    Ion.merge(`${IONKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`, {
        [reportAction.sequenceNumber]: reportAction,
    });

    if (!ActiveClientManager.isClientTheLeader()) {
        console.debug('[NOTIFICATION] Skipping notification because this client is not the leader');
        return;
    }

    // If this comment is from the current user we don't want to parrot whatever they wrote back to them.
    if (reportAction.actorEmail === currentUserEmail) {
        console.debug('[NOTIFICATION] No notification because comment is from the currently logged in user');
        return;
    }

    const currentReportID = Number(lodashGet(currentURL.split('/'), [1], 0));

    // If we are currently viewing this report do not show a notification.
    if (reportID === currentReportID && Visibility.isVisible()) {
        console.debug('[NOTIFICATION] No notification because it was a comment for the current report');
        return;
    }

    console.debug('[NOTIFICATION] Creating notification');
    Notification.showCommentNotification({
        reportAction,
        onClick: () => {
            // Navigate to this report onClick
            redirect(reportID);
        }
    });
}

/**
 * Initialize our pusher subscriptions to listen for new report comments
 */
function subscribeToReportCommentEvents() {
    // If we don't have the user's accountID yet we can't subscribe so return early
    if (!currentUserAccountID) {
        return;
    }

    const pusherChannelName = `private-user-accountID-${currentUserAccountID}`;
    if (Pusher.isSubscribed(pusherChannelName) || Pusher.isAlreadySubscribing(pusherChannelName)) {
        return;
    }

    Pusher.subscribe(pusherChannelName, 'reportComment', (pushJSON) => {
        updateReportWithNewAction(pushJSON.reportID, pushJSON.reportAction);
    });
}

/**
 * Get all chat reports and provide the proper report name
 * by fetching sharedReportList and personalDetails
 *
 * @returns {Promise} only used internally when fetchAll() is called
 */
function fetchChatReports() {
    return API.get({
        returnValueList: 'chatList',
    })

        // The string cast below is necessary as Get rvl='chatList' may return an int
        .then(({chatList}) => fetchChatReportsByIDs(String(chatList).split(',')));
}

/**
 * Get the actions of a report
 *
 * @param {number} reportID
 */
function fetchActions(reportID) {
    API.getReportHistory({reportID})
        .then((data) => {
            const indexedData = _.indexBy(data.history, 'sequenceNumber');
            const maxSequenceNumber = _.chain(data.history)
                .pluck('sequenceNumber')
                .max()
                .value();
            Ion.merge(`${IONKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`, indexedData);
            Ion.merge(`${IONKEYS.COLLECTION.REPORT}${reportID}`, {maxSequenceNumber});
        });
}

/**
 * Get all of our reports
 *
 * @param {boolean} shouldRedirectToFirstReport this is set to false when the network reconnect
 *     code runs
 * @param {boolean} shouldFetchActions whether or not the actions of the reports should also be fetched
 */
function fetchAll(shouldRedirectToFirstReport = true, shouldFetchActions = false) {
    let fetchedReports;

    // Request each report one at a time to allow individual reports to fail if access to it is prevented by Auth
    const reportFetchPromises = _.map(configReportIDs, reportID => API.get({
        returnValueList: 'reportStuff',
        reportIDList: reportID,
        shouldLoadOptionalKeys: true,
    }));

    // Chat reports need to be fetched separately than the reports hard-coded in the config
    // files. The promise for fetching them is added to the array of promises here so
    // that both types of reports (chat reports and hard-coded reports) are fetched in
    // parallel
    reportFetchPromises.push(fetchChatReports());

    promiseAllSettled(reportFetchPromises)
        .then((data) => {
            fetchedReports = _.compact(_.map(data, (promiseResult) => {
                // Grab the report from the promise result which stores it in the `value` key
                const reports = lodashGet(promiseResult, 'value.reports', {});

                // If there are multiple reports then these are the chat reports
                if (_.size(reports) > 1) {
                    return null;
                }

                // If there is no report found from the promise, return null
                // Otherwise, grab the actual report object from the first index in the values array
                return _.isEmpty(reports) ? null : _.values(reports)[0];
            }));

            const chatReports = lodashGet(_.last(data), 'value.reports', {});
            _.each(chatReports, report => fetchedReports.push(report));

            // Set the first report ID so that the logged in person can be redirected there
            // if they are on the home page
            if (shouldRedirectToFirstReport && (currentURL === '/' || currentURL === '/home')) {
                const firstReportID = _.first(_.pluck(fetchedReports, 'reportID'));

                if (firstReportID) {
                    redirect(`/${firstReportID}`);
                }
            }

            _.each(fetchedReports, (report) => {
                // Merge the data into Ion. Don't use set() here or multiSet() because then that would
                // overwrite any existing data (like if they have unread messages)
                Ion.merge(`${IONKEYS.COLLECTION.REPORT}${report.reportID}`, getSimplifiedReportObject(report));

                if (shouldFetchActions) {
                    console.debug(`[RECONNECT] Fetching report actions for report ${report.reportID}`);
                    fetchActions(report.reportID);
                }
            });
        });
}

/**
 * Get the report ID, and then the actions, for a chat report for a specific
 * set of participants
 *
 * @param {string[]} participants
 */
function fetchOrCreateChatReport(participants) {
    let reportID;

    if (participants.length < 2) {
        throw new Error('fetchOrCreateChatReport() must have at least two participants');
    }

    API.createChatReport({
        emailList: participants.join(','),
    })

        .then((data) => {
            // Set aside the reportID in a local variable so it can be accessed in the rest of the chain
            reportID = data.reportID;

            // Make a request to get all the information about the report
            return API.get({
                returnValueList: 'reportStuff',
                reportIDList: reportID,
                shouldLoadOptionalKeys: true,
            });
        })

        // Put the report object into Ion
        .then((data) => {
            const report = data.reports[reportID];

            // Store only the absolute bare minimum of data in Ion because space is limited
            const newReport = getSimplifiedReportObject(report);
            newReport.reportName = getChatReportName(report.sharedReportList);

            // Merge the data into Ion. Don't use set() here or multiSet() because then that would
            // overwrite any existing data (like if they have unread messages)
            Ion.merge(`${IONKEYS.COLLECTION.REPORT}${reportID}`, newReport);

            // Redirect the logged in person to the new report
            redirect(`/${reportID}`);
        });
}

/**
 * Add an action item to a report
 *
 * @param {number} reportID
 * @param {string} text
 * @param {object} file
 */
function addAction(reportID, text, file) {
    const actionKey = `${IONKEYS.COLLECTION.REPORT_ACTIONS}${reportID}`;

    // Convert the comment from MD into HTML because that's how it is stored in the database
    const parser = new ExpensiMark();
    const htmlComment = parser.replace(text);
    const isAttachment = _.isEmpty(text) && file !== undefined;

    // The new sequence number will be one higher than the highest
    let highestSequenceNumber = reportMaxSequenceNumbers[reportID] || 0;
    const newSequenceNumber = highestSequenceNumber + 1;

    // Update the report in Ion to have the new sequence number
    Ion.merge(`${IONKEYS.COLLECTION.REPORT}${reportID}`, {
        maxSequenceNumber: newSequenceNumber,
    });

    // Optimistically add the new comment to the store before waiting to save it to the server
    Ion.merge(actionKey, {
        [newSequenceNumber]: {
            actionName: 'ADDCOMMENT',
            actorEmail: currentUserEmail,
            person: [
                {
                    style: 'strong',
                    text: myPersonalDetails.displayName || currentUserEmail,
                    type: 'TEXT'
                }
            ],
            automatic: false,
            sequenceNumber: ++highestSequenceNumber,
            avatar: myPersonalDetails.avatarURL,
            timestamp: moment().unix(),
            message: [
                {
                    type: 'COMMENT',
                    html: isAttachment ? 'Uploading Attachment...' : htmlComment,

                    // Remove HTML from text when applying optimistic offline comment
                    text: isAttachment ? 'Uploading Attachment...'
                        : htmlComment.replace(/<[^>]*>?/gm, ''),
                }
            ],
            isFirstItem: false,
            isAttachment,
        }
    });

    API.addReportComment({
        reportID,
        reportComment: htmlComment,
        file
    });
}

/**
 * Updates the last read action ID on the report. It optimistically makes the change to the store, and then let's the
 * network layer handle the delayed write.
 *
 * @param {number} reportID
 * @param {number} sequenceNumber
 */
function updateLastReadActionID(reportID, sequenceNumber) {
    const currentMaxSequenceNumber = reportMaxSequenceNumbers[reportID];
    if (sequenceNumber < currentMaxSequenceNumber) {
        return;
    }

    lastReadActionIDs[reportID] = sequenceNumber;

    // Update the lastReadActionID on the report optimistically
    Ion.merge(`${IONKEYS.COLLECTION.REPORT}${reportID}`, {
        unreadActionCount: 0,
        reportNameValuePairs: {
            [`lastReadActionID_${currentUserAccountID}`]: sequenceNumber,
        }
    });

    // Mark the report as not having any unread items
    API.setLastReadActionID({
        accountID: currentUserAccountID,
        reportID,
        sequenceNumber,
    });
}

/**
 * Saves the comment left by the user as they are typing. By saving this data the user can switch between chats, close
 * tab, refresh etc without worrying about loosing what they typed out.
 *
 * @param {number} reportID
 * @param {string} comment
 */
function saveReportComment(reportID, comment) {
    Ion.merge(`${IONKEYS.COLLECTION.REPORT_DRAFT_COMMENT}${reportID}`, comment);
}

/**
 * When a report changes in Ion, this fetches the report from the API if the report doesn't have a name
 * and it keeps track of the max sequence number on the report actions.
 *
 * @param {object} report
 */
function handleReportChanged(report) {
    if (!report) {
        return;
    }

    // A report can be missing a name if a comment is received via pusher event
    // and the report does not yet exist in Ion (eg. a new DM created with the logged in person)
    if (report.reportName === undefined) {
        fetchChatReportsByIDs([report.reportID]);
    }

    // Store the max sequence number for each report
    reportMaxSequenceNumbers[report.reportID] = report.maxSequenceNumber;
}
Ion.connect({
    key: IONKEYS.COLLECTION.REPORT,
    callback: handleReportChanged
});

// When the app reconnects from being offline, fetch all of the reports and their actions
API.onReconnect(() => {
    fetchAll(false, true);
});

export {
    fetchAll,
    fetchActions,
    fetchOrCreateChatReport,
    addAction,
    updateLastReadActionID,
    subscribeToReportCommentEvents,
    saveReportComment,
};
