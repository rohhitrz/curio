# Study notes: gradient descent

These are my own notes from working through optimization for neural networks. They cover the basic update rule, the three batch-size variants, learning-rate choices, momentum, Adam, and the problems I keep running into.

## The update rule

Gradient descent minimizes a loss function L(θ) by repeatedly stepping in the direction of the negative gradient. One step is:

θ ← θ − η · ∇L(θ)

Here η is the learning rate and ∇L(θ) is the gradient of the loss with respect to the parameters. The gradient points uphill, in the direction of steepest increase, so subtracting it moves downhill. The size of each step is the learning rate times the length of the gradient, so steps naturally shrink as the slope flattens near a minimum.

Training stops when the loss stops improving on a validation set, after a fixed number of epochs, or when the gradient norm falls below a small tolerance such as 1e-6.

## Batch, stochastic and mini-batch

The three variants differ in how many training examples are used to estimate the gradient for one update.

### Batch gradient descent

Batch gradient descent computes the gradient over the entire training set before every update. The estimate is exact, so the path to the minimum is smooth, but every single step costs a full pass over the data. On a dataset with millions of examples that makes each update very slow, and the whole dataset may not fit in memory.

### Stochastic gradient descent (SGD)

Stochastic gradient descent updates the parameters after every single example. Updates are cheap and frequent, but each gradient estimate is noisy, so the loss curve jumps around instead of decreasing smoothly. The noise has an upside: it can knock the parameters out of shallow local minima and saddle regions.

### Mini-batch gradient descent

Mini-batch gradient descent uses a small batch of examples per update, typically 32, 64, 128 or 256. It sits between the two: the gradient is much less noisy than pure SGD, and matrix operations on a batch run efficiently on a GPU. In practice, when people say "SGD" in deep learning they almost always mean mini-batch gradient descent.

One epoch is one full pass over the training data. With 50,000 examples and a batch size of 100, one epoch is 500 updates.

## Choosing the learning rate

The learning rate is the single most important hyperparameter to tune.

- Too large: the updates overshoot the minimum, the loss oscillates, and it can diverge to NaN.
- Too small: training is stable but painfully slow, and it can stall on plateaus.

A practical way to find a good starting value is a learning-rate range test: train for a few hundred steps while increasing the learning rate exponentially from about 1e-7 to 1, plot loss against learning rate, and pick a value roughly ten times smaller than the point where the loss is lowest.

### Learning-rate schedules

A schedule changes the learning rate during training, usually lowering it so later steps can settle into a minimum.

- **Step decay:** multiply the rate by a factor (for example 0.1) every fixed number of epochs, such as every 30 epochs.
- **Exponential decay:** η_t = η_0 · e^(−k·t) for a decay constant k.
- **Cosine annealing:** the rate follows half a cosine curve from its starting value down to near zero over the training run.
- **Warmup:** start with a very small rate and increase it linearly over the first few thousand steps. Warmup is common for transformers, where large early updates can destabilize training.

## Momentum

Plain gradient descent zig-zags in long, narrow valleys: the gradient points mostly across the valley instead of along it. Momentum fixes this by keeping a running velocity that accumulates past gradients:

v ← β · v + ∇L(θ)
θ ← θ − η · v

The momentum coefficient β is usually 0.9. Components of the gradient that keep pointing the same way build up speed, while components that flip sign from step to step cancel out. The result is faster progress along the valley floor and less oscillation across it.

Nesterov momentum is a variant that evaluates the gradient at the look-ahead position θ − η·β·v instead of at θ, which often corrects overshooting a little earlier.

## Adaptive methods

Adaptive optimizers give every parameter its own effective learning rate.

- **AdaGrad** divides the step by the square root of the sum of all past squared gradients. Rarely updated parameters get larger steps, which suits sparse features, but the sum only grows, so the learning rate eventually becomes too small to make progress.
- **RMSProp** replaces that sum with an exponential moving average of squared gradients (decay rate usually 0.9), so the effective rate does not shrink forever.
- **Adam** combines momentum with RMSProp. It keeps a moving average of the gradients (first moment) and of the squared gradients (second moment), corrects both for their bias toward zero in early steps, and divides one by the square root of the other.

The Adam defaults I use are: learning rate 0.001, β1 = 0.9, β2 = 0.999 and ε = 1e-8. The ε term only prevents division by zero.

**AdamW** changes how weight decay is applied: instead of adding an L2 penalty to the loss (which Adam then rescales per parameter), it subtracts the decay directly from the weights at each step. This "decoupled" weight decay tends to generalize better and is the usual choice for training transformers.

## Common problems

### Vanishing and exploding gradients

In deep networks the gradient is a product of many per-layer terms. If those terms are mostly smaller than one, the gradient shrinks exponentially toward the early layers (vanishing gradients) and they barely learn. If they are mostly larger than one, it grows exponentially (exploding gradients) and training diverges. Remedies include ReLU activations instead of sigmoids, careful initialization (Xavier or He), residual connections, batch or layer normalization, and gradient clipping.

### Gradient clipping

Gradient clipping caps the gradient before the update. Clipping by norm rescales the whole gradient vector whenever its L2 norm exceeds a threshold, for example 1.0 or 5.0, so the direction is kept and only the length is limited. It is standard when training recurrent networks.

### Saddle points and plateaus

In high-dimensional loss surfaces, most points where the gradient is zero are saddle points rather than local minima: the surface curves up in some directions and down in others. Plain gradient descent can crawl for a long time near a saddle point because the gradient there is tiny. Momentum and the noise of mini-batches both help it escape.

## My checklist when training stalls

1. Plot the training loss per step, not just per epoch.
2. Check that the loss decreases on a tiny subset (for example 10 examples); if the model cannot overfit 10 examples, there is a bug.
3. Run a learning-rate range test before trying another optimizer.
4. Look at gradient norms per layer to spot vanishing or exploding gradients.
5. Only then change the architecture.
