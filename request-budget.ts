export const MAX_REQUEST_OPERATIONS = 6;

let remainingOperations = MAX_REQUEST_OPERATIONS;

/** Consume one logical provider/page operation; redirects stay within that operation. */
export function consumeRequestOperation(): void {
	if (remainingOperations <= 0) {
		throw new Error("Request operation budget exhausted (6 operations per run)");
	}
	remainingOperations -= 1;
}

export function remainingRequestOperations(): number {
	return remainingOperations;
}

/** Lifecycle integration calls this at the beginning of a new agent run. */
export function resetRequestOperations(): void {
	remainingOperations = MAX_REQUEST_OPERATIONS;
}

// Short aliases keep the integration seam explicit without adding another budget.
export const consumeOperation = consumeRequestOperation;
export const getRemainingOperations = remainingRequestOperations;
export const resetRequestBudget = resetRequestOperations;
